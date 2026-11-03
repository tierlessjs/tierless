"use strict";
// Tierless tier-splitting compiler (proof of concept).
//
// Input:  plain functions (e.g. app/App.src.js) written as if everything ran in one
//         place — straight-line calls to api.* and commit(), ordinary control flow,
//         and ordinary calls between functions.
// Output: SERIALIZABLE state machines whose every suspension point is a tier-pinned
//         resource request OR a call into another suspendable function. Nothing in the
//         app is hand-written as a state machine; this file generates it.
//
// Passes:
//   PASS 1  allow-list rewrite. Calls into tier-pinned namespaces become yields that
//           name the owning tier. `api.*` -> server, `commit()` -> browser (TIER_OF).
//   ANALYSIS  suspendability. A function is suspendable if it directly touches a
//           tier-pinned resource OR (transitively) calls another suspendable function.
//           Only suspendable functions are compiled into state machines; the rest are
//           emitted verbatim and called synchronously (single-tier code runs wholesale).
//   PASS 2  CPS / state-machine lowering. Each suspendable function's body is split at
//           every suspension into basic blocks emitted as `case N:` of a
//           `while(true) switch(F.pc)`. Locals/params are hoisted onto the explicit
//           frame object F, so the whole continuation is plain serializable data — no
//           closure, no native stack — and migrates between tiers mid-function.
//
// A call into another suspendable function becomes a CALL op that pushes a sub-frame:
// the continuation is a STACK of frames, so it spans function-call boundaries and the
// whole stack migrates as a unit (a callee can suspend on the server while its caller
// waits, all serialized together). Exceptions unwind across frames (__unwind), so a
// resource that fails in a callee is caught by a try/catch in a caller — even across a
// tier migration.
//
// Control flow covered: sequence, if/else, while / for / for-of / for-in, break/continue
// (incl. labeled), return, throw, switch, try/catch/finally (incl. return/break/continue that
// EXITS a try, running the finally), and cross-function calls/returns. Binding forms covered:
// destructuring declarations, default/destructured/rest parameters, a suspension used as a
// sub-expression, and a suspension in an optional chain's conditional part (a?.[susp] / a?.(susp)
// / a.m?.(susp), short-circuit + `this` preserved) — all DESUGARED to plain `F.x = expr` frame
// writes before lowering (see desugarBindings + desugarOptionalChain + normalize). Lowered the way
// @babel/plugin-transform-regenerator lowers generators, but onto an explicit serializable frame
// instead of closure variables (which is what makes snapshot/restore possible). The one genuine gap
// (the compiler throws a CLEAR error rather than miscompile): a tier call inside a nested function /
// callback / comparator / method — it runs synchronously inside native code (Array.map/sort, a
// method dispatch) that can't suspend or migrate, so lift it to a loop.
//
// Needs the Babel toolchain to RUN, but it is NOT a runtime dependency of the framework: the
// committed *.gen.mjs files are its output, so the demos and tests run without it. To regenerate:
//   npm i -D @babel/parser@8 @babel/traverse@8 @babel/generator@8 @babel/types@8
//   npx tierless build test/e2e/app/App.src.js test/e2e/app/bundle.gen.mjs
//   npx tierless build test/e2e/cf-fixtures.src.js test/e2e/cf-fixtures.gen.mjs --bare
const parser = require("@babel/parser");
const traverseModule = require("@babel/traverse");
const generatorModule = require("@babel/generator");
const t = require("@babel/types");
const fs = require("fs");
const nodeModule = require("node:module");
const { stripTypeScriptTypes } = nodeModule;
// Babel 8's own .d.ts declares both as `default` exports (@babel/generator also names
// `generate` directly) — real, always-present per the installed package's own types, so
// the original .cjs's defensive `.default || wholeModule` fallback (guarding a shape the
// type declarations say cannot happen) is dropped here.
const traverse = traverseModule.default;
const generate = generatorModule.default;
// A mix module may be authored in TypeScript (app.src.ts) instead of plain JS (app.src.js).
// Detected by filename, stripped to plain JS text BEFORE parsing — the rest of the compiler
// never sees TS syntax. Erasable TS only (mode:"strip"): the same ceiling as
// `node --experimental-strip-types` and every .mts file elsewhere in this repo, not full
// TS (no enums, no namespaces, no parameter-properties) — stripTypeScriptTypes throws a
// clear error on those rather than silently doing the wrong thing. Whitespace-replacement
// (not deletion) means every line/column position survives unchanged, so --source-map's
// line tracking needs no changes at all.
const TS_FILE = /\.(ts|mts)$/;
function stripIfTs(src, filename) {
    return filename && TS_FILE.test(filename) ? stripTypeScriptTypes(src, { mode: "strip" }) : src;
}
const gen = (n) => generate(n, { concise: true }).code;
// ---- PASS 1: allow-list rewrite. Calls to tier-pinned namespaces become yields. ----
// The allow-list: which call namespaces are tier-pinned. `api.*` -> server and `commit()` ->
// browser are the defaults; a deployment adds its own via opts.resources / --resource=ns:tier
// (a member namespace like `db.*`, or a bare call like `commit` which compiles as "dom.<name>").
const DEFAULT_RESOURCES = { api: "server", commit: "browser" };
let TIER_OF = { ...DEFAULT_RESOURCES };
function allowlist(ast) {
    traverse(ast, { CallExpression(p) {
            // class bodies are handled per-method by compileClassMethods (which re-runs this pass
            // on the isolated method); an uncompiled method must keep its RAW calls, not yields
            if (p.findParent((q) => q.isClassBody()))
                return;
            const c = p.node.callee;
            let tier = null, name = null;
            const args = p.node.arguments;
            if (t.isMemberExpression(c) && t.isIdentifier(c.object) && TIER_OF[c.object.name] && t.isIdentifier(c.property)) {
                tier = TIER_OF[c.object.name];
                name = c.object.name + "." + c.property.name; // api.getTasks(...)
            }
            else if (t.isMemberExpression(c) && t.isMemberExpression(c.object) && t.isIdentifier(c.property)
                && (t.isThisExpression(c.object.object) || (t.isIdentifier(c.object.object) && c.object.object.name === "__self"))
                && t.isIdentifier(c.object.property) && TIER_OF["this." + c.object.property.name]) {
                // this.http.get(...) — an instance-held resource (config key "this.http"). The
                // receiver is dropped from the request: the namespace is bound per tier by the
                // exec, not carried as data (the instance itself never crosses for the call).
                tier = TIER_OF["this." + c.object.property.name];
                name = c.object.property.name + "." + c.property.name;
            }
            else if (t.isIdentifier(c) && TIER_OF[c.name]) {
                tier = TIER_OF[c.name];
                name = "dom." + c.name; // commit(...)
            }
            else if (t.isIdentifier(c) && c.name === "deref") {
                tier = "@deref";
                name = "deref"; // deref(handle): fetch from the handle's owner
            }
            if (!tier || name == null)
                return; // (tier and name are always set together — this just proves it to tsc)
            const y = t.yieldExpression(t.callExpression(t.identifier("R"), [t.stringLiteral(tier), t.stringLiteral(name), ...args]));
            y.loc = p.node.loc; // keep the call site for analyze()/--source-map reporting
            // real code writes `await this.http.get(...)` — the await IS the suspension, absorb it
            if (p.parentPath.isAwaitExpression())
                p.parentPath.replaceWith(y);
            else
                p.replaceWith(y);
            // no p.skip(): keep traversing so nested tier calls in the args (e.g. api.f(api.g())) get rewritten too
        } });
}
// ---- PASS 2: state machine. Compile a suspendable function's body into basic blocks.
// ctx threads the targets break/continue/return jump to (brk/cont per loop, labels for
// labeled loops) plus tryStack — the enclosing trys — so an abrupt exit pops the right
// handlers and refuses to silently skip a finally.
let blocks, suspSet, AUTO_DEREF = false, AUTO_WRITEBACK = false, TRACK_WRITES = false;
let SOURCE_MAP = false, curLine = 0, srcFile = "", fnSites = {}; // --source-map: stamp each block with its source line so a migrated frame reports file:line, not just a pc
let CLOSURES = false; // opts.closures: compile async functions declared in component/hook bodies
let SYNC_CLOSURES = false; // opts.syncClosures: sync closures a class method creates become shippable values
let MODULE_CODE = true; // opts.moduleCode: module code a component closure only calls is a free reference, not a capture — true: any import; a list: imports from those sources (module-level functions always)
let SYNC_CALLS = false; // opts.syncCalls: sync calls to values (a captured function, a method of this/a local) are pump-dispatched parks
let SYNC_METHODS = false; // opts.syncMethods: every method of a top-level class compiles, tier calls or not (a library's machines)
let MODULE_FNS = new Set(); // the module's top-level functions (a lowered body is an isolated file: module scope is known by name only)
let fnSlots = {}; // §5 stop rule: per program per state, the frame slots its segment references (docs/migrate-arm.md)
const nb = () => { const b = { lines: [], term: null }; if (SOURCE_MAP)
    b.line = curLine; blocks.push(b); return blocks.length - 1; };
const isSusp = (s) => (t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isYieldExpression(s.declarations[0].init)) ||
    (t.isExpressionStatement(s) && t.isYieldExpression(s.expression));
// Only ever called on a statement isSusp() already verified (a VariableDeclaration whose sole
// init is a yield, or an ExpressionStatement wrapping one) — the shape isn't visible to tsc
// across that caller/callee boundary, so it's asserted here rather than re-checked.
function suspInfo(s) {
    const y = (t.isVariableDeclaration(s) ? s.declarations[0].init : s.expression);
    const assign = t.isVariableDeclaration(s) ? s.declarations[0].id.name : null;
    const call = y.argument;
    const a = call.arguments;
    const cn = call.callee.name;
    const slotPath = (e) => {
        const path = [];
        let root = e;
        while (t.isMemberExpression(root) && !root.computed && t.isIdentifier(root.property) && !isSlotRef(root)) {
            path.unshift(root.property.name);
            root = root.object;
        }
        return path.length && isSlotRef(root) ? { root, path } : { root: e, path: [] };
    };
    if (cn === "C") {
        // C(callee, ...args) — a SYNC call of a value (rewriteSyncCalls): the pump resolves the
        // callee where the run is (a program, a live function) or parks the call home
        const { root, path } = slotPath(a[0]);
        return { assign, op: `{ op: "callv", recv: ${gen(root)}, path: ${JSON.stringify(path)}, args: [${a.slice(1).map(gen).join(", ")}] }` };
    }
    if (cn === "DF") {
        // DF(f, "name", ...args) — an AWAITED call of module code by name (rewriteDynAwaits):
        // the function itself is the receiver; the pump calls it where the run is
        return { assign, op: `{ op: "dyn", recv: ${gen(a[0])}, member: ${gen(a[1])}, fn: 1, args: [${a.slice(2).map(gen).join(", ")}] }` };
    }
    if (cn === "D" || cn === "DS" || cn === "DSO") {
        // D(recv, "member", ...args) — the DYNAMIC call park (docs/migrate-arm.md slice 3).
        // The machine only DESCRIBES the call; the pump dispatches it (twin instance on a
        // class-stamped handle / nested machine on a stamped stub / promise settled in
        // place), because only the pump holds PROGRAMS, isHandle, and the twin registry.
        // A receiver that is a static member PATH off a frame slot (F.args[0].adminClient.
        // clientScopes — a borrowed service reached through a closure's caps) ships as the
        // slot plus the path. The pump walks it: live all the way at home, and on a tier
        // where the slot is a handle it can resolve the first member to a session twin
        // instead of parking the whole segment home to evaluate it.
        const path = [];
        let root = a[0];
        while (t.isMemberExpression(root) && !root.computed && t.isIdentifier(root.property) && !isSlotRef(root)) {
            path.unshift(root.property.name);
            root = root.object;
        }
        const sync = cn === "DS" ? "sync: 1, " : cn === "DSO" ? "sync: 1, opt: 1, " : ""; // a sync member call: dispatched the same way, never awaited; opt: `o.m?.()`, undefined when the member is null
        if (path.length && isSlotRef(root)) {
            return { assign, op: `{ op: "dyn", ${sync}recv: ${gen(root)}, path: ${JSON.stringify(path)}, member: ${gen(a[1])}, args: [${a.slice(2).map(gen).join(", ")}] }` };
        }
        return { assign, op: `{ op: "dyn", ${sync}recv: ${gen(a[0])}, member: ${gen(a[1])}, args: [${a.slice(2).map(gen).join(", ")}] }` };
    }
    return { assign, op: `{ op: "resource", tier: ${gen(a[0])}, name: ${gen(a[1])}, args: [${a.slice(2).map(gen).join(", ")}] }` }; // R(tier, name, ...args)
}
// a frame slot as lowering spells it: F.x, or F.args[i]
function isSlotRef(n) {
    if (!t.isMemberExpression(n) || !t.isIdentifier(n.object, { name: "F" }) || n.computed) {
        return t.isMemberExpression(n) && n.computed && t.isNumericLiteral(n.property)
            && t.isMemberExpression(n.object) && !n.object.computed && t.isIdentifier(n.object.object, { name: "F" }) && t.isIdentifier(n.object.property, { name: "args" });
    }
    return t.isIdentifier(n.property) && n.property.name !== "args" && n.property.name !== "pc";
}
// a statement that calls another suspendable (compiled) function -> push a sub-frame
function callSusp(s) {
    let call = null, assign = null;
    if (t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isCallExpression(s.declarations[0].init)) {
        call = s.declarations[0].init;
        assign = s.declarations[0].id.name;
    }
    else if (t.isExpressionStatement(s) && t.isCallExpression(s.expression))
        call = s.expression;
    if (call && t.isIdentifier(call.callee) && suspSet.has(call.callee.name))
        return { assign, fn: call.callee.name, args: call.arguments.map((a) => gen(a)).join(", ") };
    return null;
}
// A generic AST walk over ANY node shape (not just the cases callers narrow to), so its inner
// walker is intentionally untyped — see the module comment above containsSuspCall's uses.
// Walk each child value of a raw AST node, skipping Babel's position/comment metadata (which the two
// untyped walkers below must not descend into). One copy of the skip-list, so it can't drift.
const AST_META = new Set(["loc", "start", "end", "leadingComments", "trailingComments"]);
function eachChild(n, fn) { for (const k in n)
    if (!AST_META.has(k))
        fn(n[k]); }
function containsSuspCall(node) {
    let found = false;
    (function walk(n) {
        if (found || !n || typeof n !== "object")
            return;
        if (Array.isArray(n))
            return n.forEach(walk);
        if (n.type === "CallExpression" && n.callee && n.callee.type === "Identifier" && suspSet.has(n.callee.name)) {
            found = true;
            return;
        }
        eachChild(n, walk);
    })(node);
    return found;
}
// ---- ANF normalization: hoist suspensions out of expression positions ----
// A suspension is a tier resource yield (R(...)) or a call to a suspendable function.
// After this pass every suspension is `const __tN = <susp>;` or `<susp>;` — a statement,
// which is all compileStmt knows how to lower. This is what lets ordinary code compile:
// `return f(x)`, `out = api.get()`, `a + f(x)`, `g(f(x))`, `if (api.check())`, `while (...)`.
const isResYield = (n) => !!n && t.isYieldExpression(n) && t.isCallExpression(n.argument) && t.isIdentifier(n.argument.callee, { name: "R" });
const isDynYield = (n) => !!n && t.isYieldExpression(n) && t.isCallExpression(n.argument) && (t.isIdentifier(n.argument.callee, { name: "D" }) || t.isIdentifier(n.argument.callee, { name: "DF" }) || t.isIdentifier(n.argument.callee, { name: "DS" }) || t.isIdentifier(n.argument.callee, { name: "DSO" })); // the dynamic call park (slice 3); DS: its sync form; DSO: a sync optional call `o.m?.()`
const isAsyncDynYield = (n) => isDynYield(n) && (t.isIdentifier(n.argument.callee, { name: "D" }) || t.isIdentifier(n.argument.callee, { name: "DF" }));
const isCallvYield = (n) => !!n && t.isYieldExpression(n) && t.isCallExpression(n.argument) && t.isIdentifier(n.argument.callee, { name: "C" }); // a sync call of a VALUE (rewriteSyncCalls)
const isSuspCallNode = (n) => !!n && t.isCallExpression(n) && t.isIdentifier(n.callee) && suspSet.has(n.callee.name);
const isSuspExpr = (n) => isResYield(n) || isDynYield(n) || isCallvYield(n) || isSuspCallNode(n);
// Same "generic walk, untyped inner walker" shape as containsSuspCall.
function hasSuspInside(node, exclSelf) {
    let found = false;
    (function walk(n, root) {
        if (found || !n || typeof n !== "object")
            return;
        if (Array.isArray(n))
            return n.forEach((x) => walk(x, false));
        if (!(root && exclSelf) && isSuspExpr(n)) {
            found = true;
            return;
        }
        eachChild(n, (c) => walk(c, false));
    })(node, true);
    return found;
}
const isHeadNormal = (path) => {
    const p = path.parentPath;
    if (!p)
        return false;
    if (p.isExpressionStatement())
        return true;
    if (p.isVariableDeclarator() && p.node.init === path.node) {
        const d = p.parentPath;
        return !!d && d.node.declarations.length === 1 && (d.parentPath?.isBlockStatement() || d.parentPath?.isProgram() || d.parentPath?.isSwitchCase());
    }
    return false;
};
function assertSafeContext(path, stmt) {
    let cur = path;
    while (cur && cur !== stmt) {
        const par = cur.parentPath;
        if (!par)
            break;
        if (par.isLogicalExpression() && par.node.right === cur.node)
            throw new Error("suspension in the right side of && / || / ?? is not supported");
        if (par.isConditionalExpression() && (par.node.consequent === cur.node || par.node.alternate === cur.node))
            throw new Error("suspension in a branch of ?: is not supported");
        // optional chaining: the base (object/callee) is unconditional and may be hoisted; only the
        // conditional part — a computed access ?.[susp] or optional-call args ?.(susp) — is rejected.
        if (par.isOptionalMemberExpression() && par.node.optional && par.node.property === cur.node)
            throw new Error("suspension in an optional computed access (?.[ ]) is not supported (lift it to a statement)");
        if (par.isOptionalCallExpression() && par.node.optional && par.node.arguments.indexOf(cur.node) >= 0)
            throw new Error("suspension in optional-call arguments (?.()) is not supported (lift it to a statement)");
        cur = par;
    }
}
// && || ?? ?: that CONTAIN a suspension -> lift into a temp via if-statements, so only the
// taken branch's suspension evaluates. The branches/test then normalize like any statement.
function desugarCondLog(path, name) {
    const n = path.node;
    const id = () => t.identifier(name), assign = (v) => t.expressionStatement(t.assignmentExpression("=", id(), v));
    const out = [];
    if (t.isConditionalExpression(n)) {
        out.push(t.variableDeclaration("let", [t.variableDeclarator(id())]));
        out.push(t.ifStatement(n.test, t.blockStatement([assign(n.consequent)]), t.blockStatement([assign(n.alternate)])));
    }
    else { // LogicalExpression
        out.push(t.variableDeclaration("let", [t.variableDeclarator(id(), n.left)]));
        const cond = n.operator === "&&" ? id() : n.operator === "||" ? t.unaryExpression("!", id()) : t.binaryExpression("==", id(), t.nullLiteral());
        out.push(t.ifStatement(cond, t.blockStatement([assign(n.right)])));
    }
    path.getStatementParent().insertBefore(out);
    path.replaceWith(id());
}
// obj?.[api.x()] / obj?.(api.x()) / obj.m?.(api.x()) — a suspension in an optional chain's
// CONDITIONAL region must evaluate ONLY when the chain hasn't short-circuited. Peel the chain's
// deepest `?.` into an explicit `== null` guard + temp (Babel's optional-chaining lowering, but
// emitted as statements so the suspension hoists into the non-short-circuit branch). `this` is
// preserved: `obj?.m(x)` de-optionalizes only the member, so `_o.m(x)` still binds this=_o; an
// optional call on a member `obj.m?.(x)` lowers to `_f.call(_o, x)`. Iterated to a fixpoint, so a
// multi-`?.` chain peels one guard per pass (deepest first, its base being suspension-free).
function outermostChain(p) {
    let E = p;
    for (;;) {
        const par = E.parentPath;
        if (par && (par.isMemberExpression() || par.isOptionalMemberExpression()) && par.node.object === E.node)
            E = par;
        else if (par && (par.isCallExpression() || par.isOptionalCallExpression()) && par.node.callee === E.node)
            E = par;
        else
            return E;
    }
}
function chainHasOptional(E) {
    for (let cur = E; cur;) {
        if ((cur.isOptionalMemberExpression() || cur.isOptionalCallExpression()) && cur.node.optional)
            return true;
        if (cur.isMemberExpression() || cur.isOptionalMemberExpression())
            cur = cur.get("object");
        else if (cur.isCallExpression() || cur.isOptionalCallExpression())
            cur = cur.get("callee");
        else
            return false;
    }
    return false;
}
function desugarOptionalChain(E, name, fresh) {
    const cst = (nm, init) => t.variableDeclaration("const", [t.variableDeclarator(t.identifier(nm), init)]);
    const setR = (v) => t.expressionStatement(t.assignmentExpression("=", t.identifier(name), v));
    let P = null;
    let cur = E; // deepest optional along the object/callee spine
    for (;;) {
        if (cur && (cur.isOptionalMemberExpression() || cur.isOptionalCallExpression()) && cur.node.optional)
            P = cur;
        if (cur && (cur.isMemberExpression() || cur.isOptionalMemberExpression()))
            cur = cur.get("object");
        else if (cur && (cur.isCallExpression() || cur.isOptionalCallExpression()))
            cur = cur.get("callee");
        else
            break;
    }
    if (!P)
        throw new Error("tierless: desugarOptionalChain found no optional member/call in the chain");
    const out = [t.variableDeclaration("let", [t.variableDeclarator(t.identifier(name))])];
    let guard;
    if (P.isOptionalCallExpression() && (P.get("callee").isMemberExpression() || P.get("callee").isOptionalMemberExpression())) {
        const callee = P.node.callee, o = fresh(), f = fresh(); // obj.m?.(args) -> _o=obj; _f=_o.m; _f.call(_o, args)  (this=_o)
        out.push(cst(o, callee.object), cst(f, t.memberExpression(t.identifier(o), callee.property, callee.computed)));
        P.replaceWith(t.callExpression(t.memberExpression(t.identifier(f), t.identifier("call")), [t.identifier(o), ...P.node.arguments]));
        guard = f;
    }
    else if (P.isOptionalCallExpression()) {
        const f = fresh(); // f?.(args) -> _f=f; _f(args)  (this=undefined)
        out.push(cst(f, P.node.callee));
        P.replaceWith(t.callExpression(t.identifier(f), P.node.arguments));
        guard = f;
    }
    else {
        const o = fresh(); // obj?.prop / obj?.[key] -> _o=obj; _o.prop / _o[key]
        const mem = P.node;
        out.push(cst(o, mem.object));
        P.replaceWith(t.memberExpression(t.identifier(o), mem.property, mem.computed)); // real member: no residual optional=true
        guard = o;
    }
    out.push(t.ifStatement(t.binaryExpression("==", t.identifier(guard), t.nullLiteral()), t.blockStatement([setR(t.identifier("undefined"))]), t.blockStatement([setR(E.node)])));
    E.getStatementParent().insertBefore(out);
    E.replaceWith(t.identifier(name));
}
function normalize(fnPath) {
    let counter = 0;
    const fresh = () => "__t" + (counter++);
    // Wrap any non-block if-branch or loop body whose suspension will be HOISTED, so the hoisted
    // `const __t = <susp>` lands INSIDE the conditionally-executed branch — not before the if/loop,
    // where it would run unconditionally (e.g. `if (c) x = f();` must only call f when c). Else-if
    // chains (an IfStatement alternate) are left intact, and a BARE suspension statement (`else
    // api.f();` — already head-normal, no hoist) is left untouched, so Tasks-style code is unchanged.
    const willHoist = (n) => !!n && !t.isBlockStatement(n) && !t.isIfStatement(n) && hasSuspInside(n, false) && !(t.isExpressionStatement(n) && isSuspExpr(n.expression));
    // key names a body/consequent/alternate slot across If/For/While/DoWhile/ForOf/ForIn — a
    // different concrete shape per caller, so accessed dynamically rather than per-node-type.
    const wrapSusp = (p, key) => { if (willHoist(p.node[key]))
        p.get(key).replaceWith(t.blockStatement([p.node[key]])); };
    fnPath.traverse({
        IfStatement(p) { wrapSusp(p, "consequent"); wrapSusp(p, "alternate"); },
        ForStatement(p) { wrapSusp(p, "body"); }, WhileStatement(p) { wrapSusp(p, "body"); }, DoWhileStatement(p) { wrapSusp(p, "body"); },
        ForOfStatement(p) { wrapSusp(p, "body"); }, ForInStatement(p) { wrapSusp(p, "body"); },
    });
    for (let guard = 0; guard < 100000; guard++) {
        let acted = false;
        fnPath.traverse({ WhileStatement(p) {
                if (acted || t.isBooleanLiteral(p.node.test, { value: true }) || !hasSuspInside(p.node.test, false))
                    return;
                const body = t.isBlockStatement(p.node.body) ? p.node.body.body : [p.node.body];
                p.replaceWith(t.whileStatement(t.booleanLiteral(true), t.blockStatement([t.ifStatement(t.unaryExpression("!", p.node.test), t.blockStatement([t.breakStatement()])), ...body])));
                acted = true;
                p.stop();
            } });
        if (acted)
            continue;
        fnPath.traverse({ ForStatement(p) {
                if (acted)
                    return;
                const node = p.node;
                if ((node.test && hasSuspInside(node.test, false)) || (node.update && hasSuspInside(node.update, false))) {
                    // for(init;test;update) BODY -> { init; let __f=true; while(true){ if(__f)__f=false; else update; if(!test)break; BODY } }
                    const fv = fresh();
                    const body = t.isBlockStatement(node.body) ? node.body.body : [node.body];
                    const wbody = [t.ifStatement(t.identifier(fv), t.expressionStatement(t.assignmentExpression("=", t.identifier(fv), t.booleanLiteral(false))), node.update ? t.expressionStatement(node.update) : null)];
                    if (node.test)
                        wbody.push(t.ifStatement(t.unaryExpression("!", node.test), t.blockStatement([t.breakStatement()])));
                    wbody.push(...body);
                    const outer = [];
                    if (node.init)
                        outer.push(t.isVariableDeclaration(node.init) ? node.init : t.expressionStatement(node.init));
                    outer.push(t.variableDeclaration("let", [t.variableDeclarator(t.identifier(fv), t.booleanLiteral(true))]));
                    outer.push(t.whileStatement(t.booleanLiteral(true), t.blockStatement(wbody)));
                    p.replaceWith(t.blockStatement(outer));
                    acted = true;
                    p.stop();
                    return;
                }
                if (node.init && hasSuspInside(node.init, false)) { // init runs once -> a plain statement before the loop
                    p.insertBefore(t.isVariableDeclaration(node.init) ? node.init : t.expressionStatement(node.init));
                    node.init = null;
                    acted = true;
                    p.stop();
                }
            } });
        if (acted)
            continue;
        fnPath.traverse({ DoWhileStatement(p) {
                if (acted || !hasSuspInside(p.node.test, false))
                    return;
                const ov = fresh();
                const body = t.isBlockStatement(p.node.body) ? p.node.body.body : [p.node.body];
                p.replaceWith(t.blockStatement([
                    t.variableDeclaration("let", [t.variableDeclarator(t.identifier(ov), t.booleanLiteral(true))]),
                    t.whileStatement(t.logicalExpression("||", t.identifier(ov), p.node.test), t.blockStatement([t.expressionStatement(t.assignmentExpression("=", t.identifier(ov), t.booleanLiteral(false))), ...body])),
                ]));
                acted = true;
                p.stop();
            } });
        if (acted)
            continue;
        fnPath.traverse({ enter(p) {
                if (acted)
                    return;
                const n = p.node;
                if (!(t.isConditionalExpression(n) || t.isLogicalExpression(n)) || !hasSuspInside(n, false))
                    return;
                desugarCondLog(p, fresh());
                acted = true;
                p.stop();
            } });
        if (acted)
            continue;
        fnPath.traverse({ "OptionalMemberExpression|OptionalCallExpression"(p) {
                if (acted)
                    return;
                const E = outermostChain(p);
                if (!hasSuspInside(E.node, false) || !chainHasOptional(E))
                    return; // only when a real `?.` guards a suspension
                desugarOptionalChain(E, fresh(), fresh);
                acted = true;
                p.stop();
            } });
        if (acted)
            continue;
        fnPath.traverse({ enter(p) {
                if (acted)
                    return;
                const n = p.node;
                if (!isSuspExpr(n) || hasSuspInside(n, true) || isHeadNormal(p))
                    return;
                const stmt = p.getStatementParent(); // always non-null: every expression here is inside some statement in the function body
                if (stmt.isForStatement() || stmt.isDoWhileStatement() || stmt.isForOfStatement() || stmt.isForInStatement())
                    throw new Error("suspension in this loop header is not supported (assign it inside the body)");
                assertSafeContext(p, stmt);
                const name = fresh();
                stmt.insertBefore(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(name), n)]));
                p.replaceWith(t.identifier(name));
                acted = true;
                p.stop();
            } });
        if (!acted)
            break;
    }
}
const blockStmts = (n) => (t.isBlockStatement(n) ? n.body : [n]);
const withNext = (ctx, next) => ({ ...ctx, next });
function compileStmts(stmts, ctx) { let cont = ctx.next; for (let i = stmts.length - 1; i >= 0; i--)
    cont = compileStmt(stmts[i], withNext(ctx, cont)); return cont; }
// Register a loop/switch label so `break label` / `continue label` can find their targets.
const regLabel = (ctx, brk, brkDepth, cont, contDepth) => (ctx.label ? { ...ctx.labels, [ctx.label]: { brk, brkDepth, cont, contDepth } } : ctx.labels);
function compileStmt(s, ctx) {
    if (SOURCE_MAP && s.loc)
        curLine = s.loc.start.line; // blocks created while lowering this statement map back to its line
    const { next, tryDepth } = ctx;
    if (isSusp(s)) { // const x = api.f() -> suspend on a resource
        const { assign, op } = suspInfo(s);
        const r = nb();
        if (assign)
            blocks[r].lines.push(`F.${assign} = F.ret;`);
        blocks[r].term = { kind: "jump", to: next };
        const b = nb();
        blocks[b].term = { kind: "susp", op, resume: r };
        return b;
    }
    const cs = callSusp(s);
    if (cs) { // const x = helper() -> push a sub-frame for helper
        const r = nb();
        if (cs.assign)
            blocks[r].lines.push(`F.${cs.assign} = F.ret;`);
        blocks[r].term = { kind: "jump", to: next };
        const b = nb();
        blocks[b].term = { kind: "call", fn: cs.fn, args: cs.args, resume: r };
        return b;
    }
    if (t.isBlockStatement(s))
        return compileStmts(s.body, ctx);
    if (t.isEmptyStatement(s)) {
        const b = nb();
        blocks[b].term = { kind: "jump", to: next };
        return b;
    }
    if (t.isLabeledStatement(s)) { // label: loop/switch -> pass the label down for it to register
        if (t.isWhileStatement(s.body) || t.isForStatement(s.body) || t.isDoWhileStatement(s.body) || t.isSwitchStatement(s.body))
            return compileStmt(s.body, { ...ctx, label: s.label.name });
        return compileStmt(s.body, { ...ctx, labels: { ...ctx.labels, [s.label.name]: { brk: next, brkDepth: tryDepth, cont: null, contDepth: tryDepth } } });
    }
    if (t.isWhileStatement(s)) {
        const head = nb();
        const labels = regLabel(ctx, next, tryDepth, head, tryDepth);
        const body = compileStmts(blockStmts(s.body), { ...ctx, next: head, brk: next, brkDepth: tryDepth, cont: head, contDepth: tryDepth, labels, label: undefined });
        blocks[head].term = t.isBooleanLiteral(s.test, { value: true }) ? { kind: "jump", to: body } : { kind: "branch", cond: gen(s.test), then: body, else: next };
        return head;
    }
    if (t.isForStatement(s)) {
        const init = nb();
        if (s.init) {
            if (t.isVariableDeclaration(s.init))
                for (const d of s.init.declarations) {
                    if (d.init)
                        blocks[init].lines.push(`F.${d.id.name} = ${gen(d.init)};`);
                }
            else
                blocks[init].lines.push(`${gen(s.init)};`);
        }
        const head = nb(), update = nb();
        if (s.update)
            blocks[update].lines.push(`${gen(s.update)};`);
        const labels = regLabel(ctx, next, tryDepth, update, tryDepth);
        const body = compileStmts(blockStmts(s.body), { ...ctx, next: update, brk: next, brkDepth: tryDepth, cont: update, contDepth: tryDepth, labels, label: undefined }); // continue -> update
        blocks[init].term = { kind: "jump", to: head };
        blocks[head].term = s.test ? { kind: "branch", cond: gen(s.test), then: body, else: next } : { kind: "jump", to: body };
        blocks[update].term = { kind: "jump", to: head };
        return init;
    }
    if (t.isDoWhileStatement(s)) {
        if (hasSuspInside(s.test, false))
            throw new Error("suspension in a do-while test is not supported");
        const head = nb(), test = nb();
        const labels = regLabel(ctx, next, tryDepth, test, tryDepth);
        const body = compileStmts(blockStmts(s.body), { ...ctx, next: test, brk: next, brkDepth: tryDepth, cont: test, contDepth: tryDepth, labels, label: undefined });
        blocks[head].term = { kind: "jump", to: body };
        blocks[test].term = { kind: "branch", cond: gen(s.test), then: head, else: next }; // body runs first, then test loops back
        return head;
    }
    if (t.isSwitchStatement(s)) {
        if (s.cases.some((c) => c.test && containsSuspCall(c.test)))
            throw new Error("suspendable call in a case label is not supported");
        const disc = gen(s.discriminant), after = next; // discriminant already hoisted by normalize if it suspended
        const labels = regLabel(ctx, after, tryDepth, ctx.cont, ctx.contDepth); // break -> end of switch; continue -> the enclosing loop
        const swCtx = { ...ctx, brk: after, brkDepth: tryDepth, labels, label: undefined };
        const entries = new Array(s.cases.length);
        let fall = after; // cases fall through to the next
        for (let i = s.cases.length - 1; i >= 0; i--) {
            entries[i] = compileStmts(s.cases[i].consequent, { ...swCtx, next: fall });
            fall = entries[i];
        }
        const defIdx = s.cases.findIndex((c) => c.test === null);
        let dispatch = defIdx >= 0 ? entries[defIdx] : after; // no match -> default (or past the switch)
        for (let i = s.cases.length - 1; i >= 0; i--) {
            const test = s.cases[i].test;
            if (test == null)
                continue;
            const b = nb();
            blocks[b].term = { kind: "branch", cond: `${disc} === ${gen(test)}`, then: entries[i], else: dispatch };
            dispatch = b;
        }
        return dispatch;
    }
    if (t.isIfStatement(s)) {
        const consequent = compileStmts(blockStmts(s.consequent), ctx);
        const alt = s.alternate ? compileStmts(blockStmts(s.alternate), ctx) : next;
        const b = nb();
        blocks[b].term = { kind: "branch", cond: gen(s.test), then: consequent, else: alt };
        return b;
    }
    if (t.isBreakStatement(s)) {
        const tg = s.label ? ctx.labels[s.label.name] : { brk: ctx.brk, brkDepth: ctx.brkDepth };
        if (!tg || tg.brk == null)
            throw new Error("break has no target");
        return abruptExit(ctx, tg.brkDepth, { ctype: "break", targetRaw: tg.brk }); // pop crossed handlers / run crossed finallys
    }
    if (t.isContinueStatement(s)) {
        const tg = s.label ? ctx.labels[s.label.name] : { cont: ctx.cont, contDepth: ctx.contDepth };
        if (!tg || tg.cont == null)
            throw new Error("continue has no target");
        return abruptExit(ctx, tg.contDepth, { ctype: "continue", targetRaw: tg.cont });
    }
    if (t.isReturnStatement(s)) {
        return abruptExit(ctx, 0, { ctype: "return", value: s.argument ? gen(s.argument) : "undefined" });
    }
    if (t.isThrowStatement(s)) {
        const b = nb();
        blocks[b].term = { kind: "throw", value: gen(s.argument) };
        return b;
    }
    if (t.isTryStatement(s))
        return compileTry(s, ctx);
    if (containsSuspCall(s))
        throw new Error("a suspendable call must be a statement: `const x = f(...)` or `f(...);`");
    const b = nb();
    blocks[b].lines.push(gen(s));
    blocks[b].term = { kind: "jump", to: next };
    return b; // gen() of a statement already ends in ;
}
// try/catch/finally. catch+finally desugars to nested try/finally(try/catch) so only the
// two pure forms are lowered. Handlers live on the serializable stack F.__h, so a suspend
// inside a try survives migration with its catch/finally target intact.
function compileTry(s, ctx) {
    const { next, tryDepth } = ctx;
    if (s.handler && s.finalizer)
        return compileTry(t.tryStatement(t.blockStatement([t.tryStatement(s.block, s.handler, null)]), null, s.finalizer), ctx);
    // tryStack records, per enclosing try, whether it has a finally — so an abrupt exit
    // (return/break/continue) knows which handlers to pop and won't silently skip a finally.
    if (s.handler) { // pure try/catch
        const inner = { ...ctx, tryDepth: tryDepth + 1, tryStack: [...ctx.tryStack, { hasFinally: false }] };
        const entry = nb(), catchB = nb();
        const bodyEnd = nb();
        blocks[bodyEnd].lines.push("F.__h.pop();");
        blocks[bodyEnd].term = { kind: "jump", to: next };
        const body = compileStmts(blockStmts(s.block), { ...inner, next: bodyEnd });
        blocks[entry].term = { kind: "pushTry", catch: catchB, fin: null, to: body };
        const param = s.handler.param ? s.handler.param.name : null;
        if (param)
            blocks[catchB].lines.push(`F.${param} = F.__err;`);
        const catchEnd = nb();
        blocks[catchEnd].lines.push("F.__h.pop();");
        blocks[catchEnd].term = { kind: "jump", to: next };
        blocks[catchB].term = { kind: "jump", to: compileStmts(blockStmts(s.handler.body), { ...inner, next: catchEnd }) }; // handler still live during catch
        return entry;
    }
    // pure try/finally
    const entry = nb(), finB = nb();
    const inner = { ...ctx, tryDepth: tryDepth + 1, tryStack: [...ctx.tryStack, { hasFinally: true, finB }] };
    const bodyEnd = nb();
    blocks[bodyEnd].lines.push("F.__h[F.__h.length - 1].state = 2;", "F.__c = null;");
    blocks[bodyEnd].term = { kind: "jump", to: finB };
    const body = compileStmts(blockStmts(s.block), { ...inner, next: bodyEnd });
    blocks[entry].term = { kind: "pushTry", catch: null, fin: finB, to: body };
    const finEnd = nb();
    blocks[finB].term = { kind: "jump", to: compileStmts(blockStmts(s.finalizer), { ...ctx, next: finEnd, tryStack: [...ctx.tryStack, { hasFinally: false }] }) };
    blocks[finEnd].term = { kind: "finish", after: next };
    return entry;
}
// An abrupt exit (return/break/continue) crossing enclosing trys must pop each try/catch's
// handler and RUN each crossed finally (in order) before reaching its target. The completion
// (F.__c) and the finally chain are recorded; __unwindStep + the finally `finish` drive it.
function abruptExit(ctx, targetDepth, completion) {
    const crossed = ctx.tryStack.slice(targetDepth).reverse(); // innermost -> outermost
    const b = nb();
    if (!crossed.some((x) => x.hasFinally)) { // no finally crossed: just pop handlers and go
        for (let i = 0; i < crossed.length; i++)
            blocks[b].lines.push("F.__h.pop();");
        blocks[b].term = completion.ctype === "return" ? { kind: "ret", value: completion.value } : { kind: "jump", to: completion.targetRaw };
        return b;
    }
    // completion is a clean discriminated union (return has value, break/continue has targetRaw),
    // but Term's "abrupt" case stores both fields regardless of ctype (see its declaration above).
    const c = completion;
    blocks[b].term = { kind: "abrupt", ctype: c.ctype, value: c.value, targetRaw: c.targetRaw, steps: crossed.map((x) => x.hasFinally ? { finRaw: x.finB } : { pop: 1 }) };
    return b;
}
function compileFn(node) {
    const fnName = node.id.name;
    blocks = [];
    if (SOURCE_MAP)
        curLine = node.loc.start.line;
    const END = nb();
    blocks[END].term = { kind: "ret", value: "undefined" }; // fall off the end -> return undefined, matching plain-JS semantics
    const entry = compileStmts(node.body.body, { next: END, brk: END, brkDepth: 0, cont: END, contDepth: 0, tryDepth: 0, tryStack: [], labels: {}, label: undefined });
    const boot = nb();
    blocks[boot].term = { kind: "jump", to: entry }; // pc 0 -> entry
    const ids = [boot, ...Array.from(blocks.keys()).filter((i) => i !== boot)];
    const remap = new Map(ids.map((id, i) => [id, i]));
    const R = (id) => remap.get(id);
    const P = (id) => (id == null ? "null" : R(id)); // remapped pc, or null for absent catch/finally
    const emitTerm = (tm) => {
        if (tm.kind === "jump")
            return `F.pc = ${R(tm.to)}; break;`;
        if (tm.kind === "susp")
            return `F.pc = ${R(tm.resume)}; return ${tm.op};`;
        if (tm.kind === "call")
            return `F.pc = ${R(tm.resume)}; return { op: "call", fn: ${JSON.stringify(tm.fn)}, args: [${tm.args}] };`;
        if (tm.kind === "branch")
            return `if (${tm.cond}) { F.pc = ${R(tm.then)}; } else { F.pc = ${R(tm.else)}; } break;`;
        if (tm.kind === "ret")
            return `return { op: "return", value: ${tm.value} };`;
        if (tm.kind === "throw")
            return `{ const __t = __dispatch(F, ${tm.value}); if (__t == null) return { op: "throw", value: ${tm.value} }; F.pc = __t; break; }`;
        if (tm.kind === "pushTry")
            return `(F.__h || (F.__h = [])).push({ catch: ${P(tm.catch)}, fin: ${P(tm.fin)}, state: 0 }); F.pc = ${R(tm.to)}; break;`;
        if (tm.kind === "finish")
            return `{ F.__h.pop(); const __c = F.__c; if (!__c) { F.pc = ${R(tm.after)}; break; } if (__c.type === "throw") { F.__c = null; const __t = __dispatch(F, __c.arg); if (__t == null) return { op: "throw", value: __c.arg }; F.pc = __t; break; } const __p = __unwindStep(F); if (__p != null) { F.pc = __p; break; } F.__c = null; if (__c.type === "return") return { op: "return", value: __c.value }; F.pc = __c.target; break; }`;
        if (tm.kind === "abrupt") { // return/break/continue crossing a finally: record completion + drive its finally chain
            const steps = "[" + tm.steps.map((s) => "pop" in s ? `{ pop: ${s.pop} }` : `{ fin: ${R(s.finRaw)} }`).join(", ") + "]";
            const rec = tm.ctype === "return" ? `{ type: "return", value: ${tm.value}, steps: ${steps} }` : `{ type: ${JSON.stringify(tm.ctype)}, target: ${R(tm.targetRaw)}, steps: ${steps} }`;
            const exec = tm.ctype === "return" ? "return { op: \"return\", value: __c.value };" : "F.pc = __c.target; break;";
            return `F.__c = ${rec}; { const __p = __unwindStep(F); if (__p != null) { F.pc = __p; break; } const __c = F.__c; F.__c = null; ${exec} }`;
        }
        throw new Error("bad terminator " + tm.kind);
    };
    const caseText = new Map(); // raw id -> the case's full emitted text (lines + term)
    const caseLines = new Map(ids.map((id) => [id, [...blocks[id].lines, emitTerm(blocks[id].term)]]));
    for (const [id, lines] of caseLines)
        caseText.set(id, lines.join("\n"));
    if (SOURCE_MAP) {
        const sites = {};
        for (const id of ids)
            sites[R(id)] = blocks[id].line;
        fnSites[fnName] = sites;
    } // pc -> source line
    // §5 stop-rule metadata (docs/migrate-arm.md): per resume state, the frame slots the
    // segment entered there references before its next suspension. Computed on the EMITTED
    // text (F.<name> occurrences — reads, writes, and term expressions alike), closed over
    // every successor a step can reach without returning from the step function. Throw and
    // finally terms over-approximate with every handler in the function: coming home early
    // is a lost optimization, running a segment beside a handle is a wrong program.
    {
        const allCatch = [], allFin = [], allAbrupt = [];
        for (const id of ids) {
            const tm = blocks[id].term;
            if (tm.kind === "pushTry") {
                if (tm.catch != null)
                    allCatch.push(tm.catch);
                if (tm.fin != null)
                    allFin.push(tm.fin);
            }
            if (tm.kind === "abrupt" && tm.targetRaw != null)
                allAbrupt.push(tm.targetRaw);
        }
        const succs = (id) => {
            const tm = blocks[id].term;
            switch (tm.kind) {
                case "jump": return [tm.to];
                case "branch": return [tm.then, tm.else];
                case "pushTry": return [tm.to];
                case "throw": return [...allCatch, ...allFin];
                case "finish": return [tm.after, ...allCatch, ...allFin, ...allAbrupt];
                case "abrupt": return [...(tm.targetRaw != null ? [tm.targetRaw] : []), ...allFin];
                default: return []; // susp/call/ret end the step — the next segment gets its own check
            }
        };
        // args are referenced by ELEMENT (`this` lowers to F.args[0], params to F.args[i]) —
        // keep that precision, or one excised instance would park every param-using segment.
        // A dyn park whose RECEIVER is a DIRECT slot (F.x / F.args[i]) is exempted first:
        // the pump's dispatch is handle-aware by construction (twin / machine / home), so a
        // handle IN that slot must not trip the stop rule. A static PATH off a slot
        // (F.args[0].svc) is emitted as the slot plus `path` (suspInfo), so it is exempt the
        // same way: the pump walks the path and parks home itself when it meets a handle it
        // can't resolve. Argument expressions always stay scanned.
        const capsFn = t.isIdentifier(node.params[0], { name: "__caps" }); // a closure program: frame arg 0 is its caps
        const selfFn = t.isIdentifier(node.params[0], { name: "__self" }); // a method program: frame arg 0 is its receiver
        const refsOf = (id) => {
            const out = new Set();
            // a SYNC call park (callv, dyn+sync) is checked by the pump in full — receiver and
            // arguments — since only it knows whether the callee is a program (its own refs
            // guard what it reads) or native code (which must not receive a view): its text is
            // not scanned here. An async dyn park's receiver is the pump's; its args are scanned.
            // A shipped closure's generated lines are not the segment's reads either: the kept
            // original body (off-tier, calls go to the program through the stub) and the caps
            // builder (invoked by the codec, which excises what it reads).
            const text = caseText.get(id).split("\n").filter((l) => !/^\s*F\._{1,2}tierless_orig_[\w$]+ = /.test(l) && !/\.__tierless_caps = \(\) => \(\{/.test(l) && !l.includes("((__tl_orig) => {")).join("\n")
                .replace(/return \{ op: "(?:callv|dyn", sync: 1)[^\n]*\};/g, "").replace(/\b(op: "dyn", recv): F\.(?:args\[\d+\]|[A-Za-z_$][\w$]*)(?=,)/g, "$1");
            for (const m of text.matchAll(/\bF\.([A-Za-z_$][\w$]*)(\[(\d+)\])?((?:\??\.[A-Za-z_$][\w$]*)*)/g)) {
                if (m[1] === "pc")
                    continue;
                // the whole args array (a rest parameter's unpack): arg 0 of a closure or method
                // program is its caps or receiver — a view by design, checked by its own member
                // refs — so "args+" means the elements from 1
                const slot = m[1] === "args" && m[3] !== undefined ? `args[${m[3]}]` : m[1] === "args" && (capsFn || selfFn) ? "args+" : m[1];
                // a plain READ records its member chain ("args[0].user.id"): a caps VIEW's
                // primitives, nested ones too, may be read off-tier (graph.mts "views"). A write
                // or a delete (it must land on the home object) records the whole slot. A call's
                // receiver is the chain minus its last member — except a closure's own capture:
                // `F.args[0].helper(x)` is the source's plain `helper(x)`, so the function value
                // itself is the ref (a shared function stays; a borrowed one goes home).
                const members = m[4] ? m[4].split(/\??\./).slice(1) : [];
                const after = text.slice(m.index + m[0].length), before = text.slice(0, m.index);
                const call = /^\s*(?:\?\.)?\(/.test(after);
                // computed access on the chain's result (`data[lng][ns]`): consume the bracket
                // groups; an assignment after them is a write of the object reached
                let rest = after, brackets = 0;
                for (;;) {
                    const open = /^\s*(?:\?\.)?\[/.exec(rest);
                    if (!open)
                        break;
                    let depth = 0, i = open[0].length - 1;
                    for (; i < rest.length; i++) {
                        const ch = rest[i];
                        if (ch === "[")
                            depth++;
                        else if (ch === "]" && --depth === 0)
                            break;
                    }
                    rest = rest.slice(i + 1);
                    brackets++;
                }
                const tail = brackets ? rest : after;
                const write = /^\s*(?:\+\+|--|(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*\/%&|^])?=(?!=))/.test(tail) || /(?:\+\+|--|\bdelete)\s*$/.test(before);
                // a bare slot as the TARGET of a plain assignment (`F.x = …`, a local reassigned —
                // `object = object[key]`) touches nothing: the frame's own variable changes
                if (write && !members.length && !brackets && /^\s*=(?!=)/.test(after))
                    continue;
                // a WRITE through a chain (`F.o.a.b = …`, `F.o.n++`, `delete F.o.k`) needs the object
                // written to be here — a local object, or a view, whose write rides home as a delta
                // (runtime.mts viewDelta): "!" after the member written; through computed access
                // "[]!" (the object reached must be complete). A bare slot updated in place
                // (`F.n++`) reads its value.
                const comp = brackets > 1 ? "[..]" : brackets ? "[]" : ""; // one computed level: only the object indexed matters; deeper, the objects reached are unknown
                if (write) {
                    out.add(brackets ? [slot, ...members].join(".") + comp + "!" : members.length ? [slot, ...members].join(".") + "!" : slot);
                    continue;
                }
                // a read whose whole statement is `F.x = <this>;` only MOVES the value into a frame
                // slot (that slot's later uses have refs of their own): "=" — or, through computed
                // access, "[]=" / "[..]=" (runtime.mts parkHome: the object indexed must be readable
                // by any key; through two or more levels, complete)
                // the statement this read sits in (one per line of case text), and the read's
                // neighbours within it
                const ls = text.lastIndexOf("\n", m.index) + 1, le = text.indexOf("\n", m.index);
                const line = text.slice(ls, le < 0 ? undefined : le), beforeL = line.slice(0, m.index - ls), afterL = (brackets ? rest : after).slice(0, Math.max(0, (le < 0 ? text.length : le) - (m.index + m[0].length + (after.length - tail.length))));
                // a read that only TESTS presence or truthiness: `x == null`, `!x`, `typeof x`, or
                // an operand of an if/while condition — a view or a member handle at the end
                // answers like the home object (the condition opens a block, or is a lowered
                // branch: `if (c) { F.pc = 1; } else { F.pc = 2; } break;`)
                const cond = /^\s*(?:if|while) \(.*\) \{(?: F\.pc = \d+; \} else \{ F\.pc = \d+; \} break;)?$/.test(line) && /(?:\(|!|&&|\|\|)\s*$/.test(beforeL) && /^\s*(?:\)|&&|\|\|)/.test(afterL);
                // …or the sole argument of a shallow pure builtin that answers the same for a view
                // (Array.isArray: a view array is an array; Object.keys: a view has the original's own keys)
                const pureArg = /\b(?:Array\.isArray|Object\.keys)\($/.test(before) && /^\s*\)/.test(tail);
                // …or the sole argument of a DEEP pure builtin (JSON.stringify): exact over a
                // COMPLETE object — plain data all the way down, no handle, no instance view whose
                // toJSON could be missed — so it needs the "[..]" mode (runtime.mts parkHome)
                const deepPureArg = /\bJSON\.stringify\($/.test(before) && /^\s*\)/.test(tail);
                if (deepPureArg && !call) {
                    out.add([slot, ...members].join(".") + "[..]");
                    continue;
                }
                const test = !call && (/^\s*(?:[!=]==?)\s*(?:null|undefined|void 0)\b/.test(tail) || /(?:!|\btypeof\s*)$/.test(before) || cond || pureArg);
                // a read whose value only MOVES into a frame slot: the whole right side of
                // `F.x = …;`, or a bare operand of ||, &&, ?? or ?: inside it (the slot's later
                // uses have refs of their own)
                // …or the value a `return` hands to the caller's frame (its uses have refs there)
                const moveStmt = /^\s*F\.(?:args\[\d+\]|[A-Za-z_$][\w$]*) = [^;]*;$/.test(line) || /^\s*return \{ op: "return", value: [^;]*\};$/.test(line); // one statement: a park's `F.pc = n; return { op: "dyn", … }` is not a move
                const operand = moveStmt && /(?:=|value:|\|\||&&|\?\?|\?|:)\s*$/.test(beforeL) && /^\s*(?:;|\}|\|\||&&|\?\?|\?|:)/.test(afterL);
                // …or a property/element of an object or array LITERAL built by such a statement
                // (`return { obj: x, k }`): the literal is fresh data that moves on; no call may
                // sit on the line (a literal passed to native code would carry the view out)
                const literalMove = moveStmt && !/[()]/.test(line) && /(?::|\[|,)\s*$/.test(beforeL) && /^\s*(?:,|\}|\])/.test(afterL);
                const move = !call && (test || operand || literalMove);
                if (!members.length && !brackets) {
                    out.add(move ? slot + "=" : slot);
                    continue;
                } // a direct slot: a test or move only needs it present; anything else is a whole-slot use
                if (!members.length && !move) {
                    out.add(slot);
                    continue;
                }
                const chain = call && !(capsFn && slot === "args[0]" && members.length === 1) ? members.slice(0, -1) : members;
                // a computed read used as a VALUE (`f(o[k])`, `o[k] + 1`): "[]" / "[..]" — the object
                // must be complete, so whatever the key reaches is plain data (runtime.mts parkHome)
                out.add([slot, ...chain].join(".") + (move ? comp + "=" : comp));
            }
            return out;
        };
        const own = new Map(ids.map((id) => [id, refsOf(id)]));
        // a CHECKPOINT branch ends the step once its condition is decided (op "check"), so the
        // pump checks the stop rule for the side actually taken. Without it, a slot read only on
        // a side not taken (FlowDetails: `if (!flow) throw new Error(t("notFound"))`) sends
        // every run home. Only where the two sides' refs differ, and never inside an in-step
        // cycle (a loop head would return to the pump every iteration).
        const closure = (id, stop) => {
            const seen = new Set([id]), refs = new Set();
            const walk = [id];
            while (walk.length) {
                const b = walk.pop();
                for (const r of own.get(b))
                    refs.add(r);
                if (stop.has(b))
                    continue; // a checkpoint returns to the pump: its sides are checked there
                for (const s of succs(b))
                    if (!seen.has(s)) {
                        seen.add(s);
                        walk.push(s);
                    }
            }
            return { refs, seen };
        };
        const none = new Set(), checks = new Set();
        const key = (x) => [...x].sort().join(",");
        for (const id of ids) {
            const tm = blocks[id].term;
            if (tm.kind !== "branch")
                continue;
            const a = closure(tm.then, none), b = closure(tm.else, none);
            if (key(a.refs) !== key(b.refs) && !a.seen.has(id) && !b.seen.has(id))
                checks.add(id);
        }
        for (const id of checks) {
            const lines = caseLines.get(id);
            lines[lines.length - 1] = lines[lines.length - 1].replace(/ break;$/, ' return { op: "check" };');
        }
        const table = {};
        for (const id of ids) {
            const refs = closure(id, checks).refs;
            if (refs.size)
                table[R(id)] = [...refs].sort();
        }
        fnSlots[fnName] = table;
    }
    const cases = ids.map((id) => `      case ${R(id)}:\n        ${caseLines.get(id).join("\n        ")}`).join("\n");
    // default: every reachable pc has a case, so landing here means a corrupt frame — a transform bug, or
    // a continuation mangled in transit. Hard-error at once instead of letting `while (true)` spin forever:
    // fail fast and loud rather than hang. (No valid run reaches it; this is a safety net, not control flow.)
    return `  ${fnName}(F) {\n    while (true) switch (F.pc) {\n${cases}\n      default: throw new RangeError("tierless: invalid pc " + F.pc + " in ${fnName}");\n    }\n  }`;
}
// Rewrite a suspendable function's locals/params -> F.x, then compile it to a machine.
// --auto-deref: transparent deref. A local bound from a data resource (const L = api.f())
// may arrive on another tier as a §5 handle. Before every READ of such a local, guard it
// with `if (isHandle(L)) L = deref(L)` so the first touch fetches it (and materializes it
// in place, so later touches are cheap checks). The developer writes ordinary L.x / L[i].
// Locals bound from a data resource (const L = api.f()) — these may arrive on another tier
// as a §5 handle, so reads of them get a deref guard and writes through them get a write-back.
function remotableLocals(p) {
    const remotable = new Set();
    const isDataResource = (name) => { const ns = String(name).split(".")[0]; return TIER_OF[ns] === "server"; }; // any server-pinned namespace (api.*, db.*, …)
    p.traverse({ VariableDeclarator(v) {
            const init = v.node.init;
            if (t.isYieldExpression(init) && t.isCallExpression(init.argument) && t.isIdentifier(init.argument.callee, { name: "R" })
                && t.isStringLiteral(init.argument.arguments[1]) && isDataResource(init.argument.arguments[1].value) && t.isIdentifier(v.node.id))
                remotable.add(v.node.id.name);
        } });
    return remotable;
}
function insertDerefGuards(p) {
    const remotable = remotableLocals(p);
    if (!remotable.size)
        return remotable;
    // Collect, per statement, the remotable locals READ at that statement's own level. getStatementParent
    // attaches a read to its nearest enclosing statement, so a read in an if-test lands on the IfStatement
    // and a read in the body lands on the body statement — the right guard placement either way.
    const reads = new Map(); // stmt node -> { path, locals:Set }
    p.traverse({ Identifier(ip) {
            const name = ip.node.name;
            if (!remotable.has(name) || !ip.isReferencedIdentifier())
                return; // reads only (not the binding / write target)
            const stmt = ip.getStatementParent();
            if (!stmt)
                return;
            if (!reads.has(stmt.node))
                reads.set(stmt.node, { path: stmt, locals: new Set() });
            reads.get(stmt.node).locals.add(name);
        } });
    // Availability pruning (the liveness pass). A guard's `L = deref(L)` materializes L; once materialized,
    // L stays a plain object until a MIGRATION — a tier hop can re-excise a big local back into a handle,
    // so each read past a hop must re-check (this is why the every-read version is correct, not merely
    // pessimistic). Within a straight-line run of sibling statements with NO intervening migration, then,
    // only the first read of L needs a guard; the rest are redundant. We never carry availability across a
    // migration, a control-flow statement (a join/back-edge could reach a read un-materialized), or a block
    // boundary (each nested list starts fresh) — all conservative, so the result stays exactly correct,
    // just without the repeated re-checks. A migration here is a `yield` (every YieldExpression is a real
    // tier hop — the @deref/@writeback guards aren't inserted yet) OR a call to a suspendable function (it
    // can hop inside its sub-frame), so both clear the available set.
    const survive = new Map(); // path -> Set(locals) to actually guard
    for (const { path, locals } of reads.values())
        survive.set(path, new Set(locals));
    const hasMigration = (sp) => { let m = false; sp.traverse({ YieldExpression() { m = true; }, CallExpression(cp) { const c = cp.node.callee; if (t.isIdentifier(c) && suspSet.has(c.name))
            m = true; } }); return m; };
    const isControlFlow = (sp) => sp.isIfStatement() || sp.isForStatement() || sp.isWhileStatement() || sp.isDoWhileStatement()
        || sp.isForOfStatement() || sp.isForInStatement() || sp.isSwitchStatement() || sp.isTryStatement() || sp.isLabeledStatement() || sp.isBlockStatement();
    const containers = new Map(); // sibling array -> its array of sibling paths
    for (const { path } of reads.values())
        if (Array.isArray(path.container) && !containers.has(path.container))
            containers.set(path.container, path.parentPath.get(path.listKey));
    for (const sibs of containers.values()) {
        const mat = new Set();
        for (const sp of sibs) {
            const barrier = hasMigration(sp) || isControlFlow(sp);
            const entry = reads.get(sp.node);
            if (entry && !barrier) {
                const s = survive.get(entry.path);
                for (const L of entry.locals) {
                    if (mat.has(L))
                        s.delete(L);
                    else
                        mat.add(L);
                }
            } // prune reads already available
            if (barrier)
                mat.clear(); // a hop or a join: nothing is known-materialized afterward
        }
    }
    for (const [path, locals] of survive) {
        if (!locals.size)
            continue;
        const g = [...locals].map((L) => t.ifStatement(t.callExpression(t.identifier("isHandle"), [t.identifier(L)]), t.blockStatement([t.expressionStatement(t.assignmentExpression("=", t.identifier(L), t.yieldExpression(t.callExpression(t.identifier("R"), [t.stringLiteral("@deref"), t.stringLiteral("deref"), t.identifier(L)]))))])));
        path.insertBefore(g);
    }
    return remotable;
}
// --auto-writeback: transparent write-back, the symmetric partner of --auto-deref. A member
// MUTATION through a remotable local (`L.x = …`, `L[i].y = …`, `L[i]++`) edits the snapshot
// fetched on this tier; that edit must propagate to the owning master. After each such
// statement emit `yield R("@writeback","writeback", L)`, which the runtime resolves with an
// optimistic version-checked CAS (heap.mjs writeBack). Whole-identifier rebinds (`L = …`,
// incl. the deref guard's own `L = deref(L)`) are NOT writes through the object, so they're
// left alone. The developer writes ordinary `L[i].x = v`.
function rootOfMember(node) {
    let o = node;
    while (t.isMemberExpression(o))
        o = o.object;
    return t.isIdentifier(o) ? o.name : null;
}
function insertWriteBacks(p, remotable) {
    if (!remotable.size)
        return;
    const backs = new Map(); // statement node -> { path, locals } to write back after it
    const note = (target, ip) => {
        if (!t.isMemberExpression(target))
            return; // only member mutations propagate (a rebind doesn't touch the object)
        const root = rootOfMember(target);
        if (!root || !remotable.has(root))
            return;
        const stmt = ip.getStatementParent();
        if (!stmt)
            return;
        if (!backs.has(stmt.node))
            backs.set(stmt.node, { path: stmt, locals: new Set() });
        backs.get(stmt.node).locals.add(root);
    };
    p.traverse({
        AssignmentExpression(ap) { note(ap.node.left, ap); }, // L[i].x = v   (any operator: =, +=, …)
        UpdateExpression(up) { note(up.node.argument, up); }, // L[i].x++ / --L.x
    });
    for (const { path, locals } of backs.values()) {
        const wb = [...locals].map((L) => t.expressionStatement(t.yieldExpression(t.callExpression(t.identifier("R"), [t.stringLiteral("@writeback"), t.stringLiteral("writeback"), t.identifier(L)]))));
        path.insertAfter(wb);
    }
}
// --track-writes: a compiler write-barrier for the delta wire's write-tracked mode (wire-delta.mjs
// encodeDeltaTracked). The instant a continuation object is mutated in place, mark it dirty so a
// later capture ships it WITHOUT re-hashing the whole graph — O(changed), not O(reachable). Each
// in-place mutation's target object is wrapped in __dirty(obj), a helper that reports the object to
// the installed sink (the active delta session) and RETURNS it, so the write proceeds unchanged and
// the base is evaluated exactly once. No suspension — marking is a local Set add, not a tier hop.
// Scoped to chains ROOTED AT A FRAME LOCAL/PARAM (continuation state), so the dirty set never names
// a global/import. Covers `o.x = v` / `o[i] = v` (any operator), `o.x++`, the in-place array mutators,
// and the Map/Set mutators (set/add/delete/clear) — the delta codec models Map/Set as first-class.
// A custom method that mutates without one of these names isn't seen; that continuation falls back
// to rescan, which needs no barrier. (Marking a same-named method on a non-container only over-ships.)
const MUTATOR_METHODS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "add", "delete", "clear"]);
function localNamesOf(p) {
    const names = new Set(p.node.params.filter((x) => t.isIdentifier(x)).map((x) => x.name));
    p.traverse({ VariableDeclarator(v) { if (t.isIdentifier(v.node.id))
            names.add(v.node.id.name); },
        CatchClause(c) { if (c.node.param && t.isIdentifier(c.node.param))
            names.add(c.node.param.name); } });
    return names;
}
function wrapBase(memberPath) {
    const objPath = memberPath.get("object");
    if (t.isCallExpression(objPath.node) && t.isIdentifier(objPath.node.callee, { name: "__dirty" }))
        return;
    objPath.replaceWith(t.callExpression(t.identifier("__dirty"), [objPath.node]));
    objPath.skip(); // don't descend into the wrapper just created
}
function insertDirtyBarriers(p) {
    const locals = localNamesOf(p);
    const rooted = (member) => { const r = rootOfMember(member); return !!r && locals.has(r); }; // a continuation root, not a global
    p.traverse({
        AssignmentExpression(ap) { const tgt = ap.node.left; if (t.isMemberExpression(tgt) && rooted(tgt))
            wrapBase(ap.get("left")); },
        UpdateExpression(up) { const tgt = up.node.argument; if (t.isMemberExpression(tgt) && rooted(tgt))
            wrapBase(up.get("argument")); },
        CallExpression(cp) { const c = cp.node.callee; if (t.isMemberExpression(c) && !c.computed && t.isIdentifier(c.property) && MUTATOR_METHODS.has(c.property.name) && rooted(c))
            wrapBase(cp.get("callee")); },
    });
}
// Emitted into the bundle under --track-writes. The owner installs a sink (the delta session's dirty
// set) around stepping via __setDirtySink (which returns the prior sink for save/restore); with none
// installed __dirty is a no-op that just returns its argument, so an untracked driver runs identically
// and serialization is unaffected (no function ever lands on a frame).
const TRACK_PREAMBLE = `let __DSINK = null;
export const __setDirtySink = (fn) => { const prev = __DSINK; __DSINK = fn || null; return prev; };
const __dirty = (o) => { if (__DSINK !== null && o !== null && typeof o === "object") __DSINK(o); return o; };`;
// ---- Pre-normalization desugars: lower non-trivial binding forms to simple `id = expr`. ----
// for-of/for-in, destructuring declarations, and non-simple params (defaults/patterns/rest)
// aren't things compileStmt or the F.x local-rewrite know how to place on the frame — so we
// rewrite each into the simple forms they DO handle, BEFORE the auto-* passes and normalize.
// Run only inside lower() (suspendable fns); a pure single-tier fn keeps its native for-of /
// destructuring (emitted verbatim, run wholesale), so this is purely additive.
//
// Two small runtime helpers are emitted into the bundle ONLY when a construct needs them, so
// a bundle that uses neither is byte-for-byte unchanged.
let USED_FORIN = false, USED_OBJREST = false;
const FORIN_HELPER = "const __forInKeys = (o) => { const a = []; for (const k in o) a.push(k); return a; };"; // for-in key order (incl. inherited enumerable)
const OBJREST_HELPER = "const __objRest = (o, taken) => { const r = {}; for (const k of Object.keys(o)) if (!taken.includes(k)) r[k] = o[k]; return r; };"; // { ...rest } = own enumerable minus taken
// Bind `target` (an Identifier / pattern / default) from the value `access` reads, appending
// the resulting simple declarations to `out`. Recurses through nested patterns and defaults.
// target/pattern are typed as t.Node throughout this trio (bindValue/flattenPattern/callers) —
// each is discriminated at runtime via t.isXxx checks, not by the caller pre-narrowing a union
// of Identifier/AssignmentPattern/ArrayPattern/ObjectPattern that Babel's own LVal/PatternLike
// types don't cleanly unify either.
function bindValue(target, access, out, fresh, kind) {
    const decl = (name, init) => out.push(t.variableDeclaration(kind, [t.variableDeclarator(t.identifier(name), init)]));
    if (t.isAssignmentPattern(target)) { // x = D  (default applies when the slot is undefined)
        const p = fresh();
        decl(p, access);
        const chosen = t.conditionalExpression(t.binaryExpression("===", t.identifier(p), t.identifier("undefined")), target.right, t.identifier(p));
        if (t.isIdentifier(target.left)) {
            decl(target.left.name, chosen);
            return;
        }
        const q = fresh();
        decl(q, chosen);
        flattenPattern(target.left, t.identifier(q), out, fresh, kind);
        return;
    }
    if (t.isIdentifier(target)) {
        decl(target.name, access);
        return;
    }
    const tmp = fresh();
    decl(tmp, access);
    flattenPattern(target, t.identifier(tmp), out, fresh, kind); // nested pattern: eval the source once
}
// Expand a destructuring pattern reading from `access` into a flat list of simple declarations.
// `access` is embedded in several sibling positions, so clone it each time — an AST node must have
// a single parent or the later F.x rewrite traversal mishandles it.
function flattenPattern(pattern, access, out, fresh, kind) {
    const A = () => t.cloneNode(access, true);
    if (t.isObjectPattern(pattern)) {
        const taken = []; // keys consumed so far, for a trailing ...rest
        let hasComputed = false;
        for (const prop of pattern.properties) {
            if (t.isRestElement(prop)) {
                if (hasComputed)
                    throw new Error("tierless: a computed key together with ...rest in object destructuring is not supported (lift it to a local first)");
                USED_OBJREST = true;
                bindValue(prop.argument, t.callExpression(t.identifier("__objRest"), [A(), t.arrayExpression(taken.map((k) => t.stringLiteral(k)))]), out, fresh, kind);
                continue;
            }
            const idKey = t.isIdentifier(prop.key) && !prop.computed; // { a: v } -> access.a
            const computed = !idKey; // { "a-b": v } / { 0: v } / { [k]: v } -> access[key]
            if (prop.computed)
                hasComputed = true;
            else
                taken.push(idKey ? prop.key.name : String(prop.key.value));
            bindValue(prop.value, t.memberExpression(A(), idKey ? t.identifier(prop.key.name) : prop.key, computed), out, fresh, kind);
        }
        return;
    }
    // ArrayPattern: normalize the source to an array ONCE — a real array passes through by reference
    // (zero copy), any other iterable (Set/Map/string/array-like) materializes. Correct for all, cheap
    // for the common case. Element reads are then index accesses and ...rest is a .slice.
    const arrPattern = pattern;
    const arr = fresh();
    out.push(t.variableDeclaration(kind, [t.variableDeclarator(t.identifier(arr), t.conditionalExpression(t.callExpression(t.memberExpression(t.identifier("Array"), t.identifier("isArray")), [A()]), A(), t.callExpression(t.memberExpression(t.identifier("Array"), t.identifier("from")), [A()])))]));
    arrPattern.elements.forEach((el, i) => {
        if (el == null)
            return; // elision: const [, x] = a
        if (t.isRestElement(el)) {
            bindValue(el.argument, t.callExpression(t.memberExpression(t.identifier(arr), t.identifier("slice")), [t.numericLiteral(i)]), out, fresh, kind);
            return;
        }
        bindValue(el, t.memberExpression(t.identifier(arr), t.numericLiteral(i), true), out, fresh, kind);
    });
}
// `const/let PATTERN = INIT`  ->  `const _t = INIT; <extractions>`. Any RHS that suspends is
// bound to the temp first, so normalize lowers it like any other suspension.
function desugarDestructuring(fnPath, fresh) {
    for (let guard = 0; guard < 100000; guard++) {
        let acted = false;
        fnPath.traverse({ VariableDeclaration(p) {
                if (acted)
                    return;
                if (t.isForStatement(p.parent) && p.parent.init === p.node)
                    return; // a C-style for head keeps its own init
                if (!p.node.declarations.some((d) => !t.isIdentifier(d.id)))
                    return; // all bindings simple: nothing to do
                const out = [];
                for (const d of p.node.declarations) {
                    if (t.isIdentifier(d.id)) {
                        out.push(t.variableDeclaration(p.node.kind, [d]));
                        continue;
                    }
                    const tmp = fresh();
                    out.push(t.variableDeclaration(p.node.kind, [t.variableDeclarator(t.identifier(tmp), d.init)]));
                    flattenPattern(d.id, t.identifier(tmp), out, fresh, p.node.kind);
                }
                p.replaceWithMultiple(out);
                acted = true;
                p.stop();
            } });
        if (!acted)
            break;
    }
}
// for-of / for-in  ->  materialize the sequence once, then a C-style index loop the compiler
// already lowers. for-of uses Array.from (any iterable); for-in uses __forInKeys (enumerable
// keys, inherited included). The eager materialization is the price of migratability: a lazy
// native iterator holds a closure/native cursor that can't be serialized and shipped anyway.
function desugarForEach(fnPath, fresh) {
    for (let guard = 0; guard < 100000; guard++) {
        let acted = false;
        const visit = (p) => {
            if (acted)
                return;
            const node = p.node, isOf = t.isForOfStatement(node);
            if (isOf && node.await)
                throw new Error("tierless: for-await-of is not supported (no async in this model)");
            const s = fresh(), i = fresh();
            const src = isOf ? t.callExpression(t.memberExpression(t.identifier("Array"), t.identifier("from")), [node.right])
                : (USED_FORIN = true, t.callExpression(t.identifier("__forInKeys"), [node.right]));
            const elem = t.memberExpression(t.identifier(s), t.identifier(i), true); // _s[_i]
            const bind = t.isVariableDeclaration(node.left)
                ? t.variableDeclaration(node.left.kind, [t.variableDeclarator(node.left.declarations[0].id, elem)]) // const x / const [a,b] = _s[_i]
                : t.expressionStatement(t.assignmentExpression("=", node.left, elem)); // x = _s[_i]
            const body = t.isBlockStatement(node.body) ? node.body.body : [node.body];
            const loop = t.forStatement(t.variableDeclaration("let", [t.variableDeclarator(t.identifier(i), t.numericLiteral(0))]), t.binaryExpression("<", t.identifier(i), t.memberExpression(t.identifier(s), t.identifier("length"))), t.assignmentExpression("=", t.identifier(i), t.binaryExpression("+", t.identifier(i), t.numericLiteral(1))), t.blockStatement([bind, ...body]));
            // A labeled `outer: for (x of xs)` must keep the label ON THE LOOP so `continue outer` still
            // targets a loop, not the wrapping block — move it onto the inner for and replace the label node.
            const parentPath = p.parentPath;
            const labeled = parentPath.isLabeledStatement() && parentPath.node.body === node;
            const inner = labeled ? t.labeledStatement(t.identifier(parentPath.node.label.name), loop) : loop;
            const block = t.blockStatement([t.variableDeclaration("const", [t.variableDeclarator(t.identifier(s), src)]), inner]);
            (labeled ? parentPath : p).replaceWith(block);
            acted = true;
            p.stop();
        };
        fnPath.traverse({ ForOfStatement: visit, ForInStatement: visit });
        if (!acted)
            break;
    }
}
// Non-simple params (defaults, destructuring, rest) -> a plain arg identifier + a body prologue.
// A default becomes `if (x === undefined) x = D` (D may itself suspend); a pattern param becomes
// a fresh arg + `const {…} = _a` (then desugared); a rest becomes `const xs = F.args.slice(i)`.
function desugarParams(fnPath, fresh) {
    const node = fnPath.node;
    if (!node.params.some((p) => !t.isIdentifier(p)))
        return;
    const prologue = [];
    node.params = node.params.map((param, i) => {
        if (t.isIdentifier(param))
            return param;
        if (t.isRestElement(param)) { // ...xs  ->  const xs = F.args.slice(i)  (xs is now a frame local)
            const slice = t.callExpression(t.memberExpression(t.memberExpression(t.identifier("F"), t.identifier("args")), t.identifier("slice")), [t.numericLiteral(i)]);
            if (t.isIdentifier(param.argument))
                prologue.push(t.variableDeclaration("const", [t.variableDeclarator(param.argument, slice)]));
            else {
                const a = fresh();
                prologue.push(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(a), slice)]));
                prologue.push(t.variableDeclaration("const", [t.variableDeclarator(param.argument, t.identifier(a))]));
            }
            return null; // drop from the param list
        }
        let target = param;
        let def = null;
        if (t.isAssignmentPattern(param)) {
            target = param.left;
            def = param.right;
        }
        const slot = t.isIdentifier(target) ? target.name : fresh();
        if (def)
            prologue.push(t.ifStatement(t.binaryExpression("===", t.identifier(slot), t.identifier("undefined")), t.expressionStatement(t.assignmentExpression("=", t.identifier(slot), def))));
        if (!t.isIdentifier(target))
            prologue.push(t.variableDeclaration("const", [t.variableDeclarator(target, t.identifier(slot))])); // pattern param -> destructure the slot
        return t.identifier(slot);
    }).filter((x) => x !== null);
    node.body.body.unshift(...prologue);
}
function desugarBindings(fnPath) {
    let n = 0;
    const fresh = () => "__b" + (n++);
    desugarParams(fnPath, fresh); // params first (their prologue may add destructuring / loops downstream)
    desugarForEach(fnPath, fresh); // then loops (a for-of binding may itself be a pattern)
    desugarDestructuring(fnPath, fresh); // finally every pattern, incl. those the two passes above introduced
}
// A frame is { fn, pc, args, ret, __h, __c, __err, __t0…, <locals> }: a local with one of
// those names would BE that field once it lowers to F.<name> (params lower to F.args[i],
// so they can't clash) — `const args =
// {…}` overwrote the frame's own arguments (Keycloak's group picker read F.args[0] as its
// caps and got the query object). Rename them first, scope-aware, so nested closures that
// read them follow. `F` itself is the frame.
const FRAME_FIELD = (name) => name === "F" || name === "fn" || name === "pc" || name === "args" || name === "ret" || name.startsWith("__");
function renameFrameClashes(p) {
    const clash = new Set();
    p.traverse({
        VariableDeclarator(v) { if (v.getFunctionParent()?.node === p.node && t.isIdentifier(v.node.id) && FRAME_FIELD(v.node.id.name))
            clash.add(v.node.id.name); },
        CatchClause(c) { if (c.getFunctionParent()?.node === p.node && t.isIdentifier(c.node.param) && FRAME_FIELD(c.node.param.name))
            clash.add(c.node.param.name); },
    });
    // params that desugar into LOCALS (a rest element, a destructured pattern) clash like
    // locals: `t(...args)` would become `F.args = F.args.slice(1)`, clobbering the frame's
    // own arguments. A plain param (defaulted or not) stays a param (F.args[i]) and must keep
    // its name — renaming it once hid a closure's `__caps`.
    const localsFromParam = (prm) => {
        if (t.isRestElement(prm))
            return t.isIdentifier(prm.argument) ? [prm.argument.name] : Object.keys(t.getBindingIdentifiers(prm.argument));
        if (t.isAssignmentPattern(prm))
            return t.isIdentifier(prm.left) ? [] : Object.keys(t.getBindingIdentifiers(prm.left));
        return t.isIdentifier(prm) ? [] : Object.keys(t.getBindingIdentifiers(prm));
    };
    for (const prm of p.node.params)
        for (const n of localsFromParam(prm))
            if (FRAME_FIELD(n))
                clash.add(n);
    if (!clash.size)
        return;
    const scopes = new Set([p.scope]);
    p.traverse({ Scopable(sp) { if (sp.getFunctionParent()?.node === p.node || sp.node === p.node)
            scopes.add(sp.scope); } });
    for (const sc of scopes)
        for (const name of clash)
            if (Object.prototype.hasOwnProperty.call(sc.bindings, name))
                sc.rename(name, sc.generateUid(name.replace(/^_+/, "") || "v"));
}
function lower(p) {
    renameFrameClashes(p); // before anything lowers a name to F.<name>
    desugarBindings(p); // for-of/for-in, destructuring, non-simple params -> simple forms
    // AUTO_WRITEBACK forces AUTO_DEREF (a write through a handle must first materialize it), so whenever
    // insertWriteBacks runs, insertDerefGuards just ran on the same p — reuse its remotable-locals scan
    // instead of re-traversing the function a second time for an identical result.
    const remotable = AUTO_DEREF ? insertDerefGuards(p) : null; // before normalize: the guard's `L = deref(L)` is a suspension to hoist
    if (AUTO_WRITEBACK)
        insertWriteBacks(p, remotable); // non-null: configure() forces AUTO_DEREF whenever AUTO_WRITEBACK is set
    if (TRACK_WRITES)
        insertDirtyBarriers(p); // after writeback/deref — their analyses need the unwrapped mutation target
    normalize(p); // hoist suspensions out of expression positions first
    const node = p.node;
    const params = node.params.map((x) => x.name); // desugarParams already reduced these to plain identifiers
    // frame locals are THIS function's own declarations. A nested closure's local is plain
    // JS that never suspends — it stays a real `const`; collecting it here (or rewriting its
    // declaration below) would split it across the frame (`F.reader = …` written, bare
    // `reader` read) and clobber any same-named frame slot.
    const locals = new Set();
    p.traverse({ VariableDeclarator(v) { if (v.getFunctionParent()?.node === node && t.isIdentifier(v.node.id))
            locals.add(v.node.id.name); } });
    p.traverse({ CatchClause(c) { if (c.getFunctionParent()?.node === node && c.node.param && t.isIdentifier(c.node.param))
            locals.add(c.node.param.name); } });
    p.traverse({ CallExpression(cp) {
            const c = cp.node.callee;
            if (!(t.isIdentifier(c) && suspSet.has(c.name)))
                return;
            if (cp.getFunctionParent()?.node !== node)
                throw new Error(`tierless: a call to suspendable function ${c.name}() inside a nested function / callback is not supported — lift it to a statement in the top-level function body (e.g. \`for (const x of xs) { const r = ${c.name}(x); }\`).`);
            const par = cp.parent;
            if (!((t.isVariableDeclarator(par) && par.init === cp.node) || (t.isExpressionStatement(par) && par.expression === cp.node)))
                throw new Error(`suspendable call ${c.name}(...) must be a statement, not a sub-expression`);
        } });
    p.traverse({ Identifier(ip) {
            const name = ip.node.name;
            if (name === "F" || !(params.includes(name) || locals.has(name)))
                return;
            const par = ip.parent;
            // Property position excludes the rewrite for BOTH member forms. The optional form
            // (`e?.response` with a local `response`) was briefly REFUSED here: its first-ever
            // compilation broke vikunja's auth boot, and the compiled program was suspected.
            // Root cause landed elsewhere — the chain MIGRATED to a session twin whose
            // makeTwins() had token: null (the gateway never plumbed the upgrade bearer), so
            // getToken() returned null on the twin and refreshUserInfo silently early-returned.
            // The shape itself compiles correctly (compiled-vs-oracle probes, fetch and shapes
            // alike); the twin-auth plumb is the fix (bin/tierless.mts bearerFromUpgrade).
            if ((t.isMemberExpression(par) || t.isOptionalMemberExpression(par)) && par.property === ip.node && !par.computed)
                return;
            if (t.isObjectProperty(par) && par.key === ip.node && !par.computed)
                return;
            if (t.isVariableDeclarator(par) && par.id === ip.node)
                return;
            if (t.isCatchClause(par) && par.param === ip.node)
                return;
            if (t.isFunction(par))
                return;
            // Scope-resolve the name: if it's bound by a NESTED function (its own param/local, shadowing the
            // frame local — e.g. `xs.map(x => x)` where `x` is also a frame local), leave it alone. A nested
            // BLOCK's local and a nested function closing OVER a frame local both still resolve to THIS
            // function, so they still rewrite to F.x. Without this, the name-based rewrite corrupts shadows.
            const binding = ip.scope.getBinding(name);
            const bindingFn = binding && binding.path.getFunctionParent();
            if (bindingFn && bindingFn.node !== node)
                return;
            if (params.includes(name))
                ip.replaceWith(t.memberExpression(t.memberExpression(t.identifier("F"), t.identifier("args")), t.numericLiteral(params.indexOf(name)), true));
            else
                ip.replaceWith(t.memberExpression(t.identifier("F"), t.identifier(name)));
            ip.skip();
        } });
    p.traverse({ VariableDeclaration(v) {
            if (v.getFunctionParent()?.node !== node)
                return; // a nested closure's declaration stays a real const/let
            if (isSusp(v.node) || callSusp(v.node))
                return; // leave suspensions for compileStmt
            if (t.isForStatement(v.parent) && v.parent.init === v.node)
                return;
            const assigns = v.node.declarations.filter((d) => d.init).map((d) => t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("F"), t.identifier(d.id.name)), d.init)));
            if (assigns.length)
                v.replaceWithMultiple(assigns);
            else
                v.remove();
        } });
    return compileFn(node);
}
// A suspension is only migratable if it sits directly in a top-level function that becomes a
// PROGRAM. Inside a nested function / callback / method it would be invoked synchronously by
// native code (Array.map/sort, a method dispatch) that cannot yield or migrate, so reject it
// with a precise error rather than silently miscompile. (Runs on tier calls right after the
// allow-list rewrite; suspendable-call-in-callback is caught per-function in lower().)
function checkNestedSuspensions(ast) {
    traverse(ast, { YieldExpression(p) {
            if (!isResYield(p.node))
                return;
            const fn = p.getFunctionParent();
            if (fn && t.isFunctionDeclaration(fn.node) && fn.parentPath && (t.isProgram(fn.parentPath.node)
                || (fn.parentPath.isExportNamedDeclaration() && t.isProgram(fn.parentPath.parentPath.node))))
                return;
            const nameArg = p.node.argument.arguments[1];
            const name = t.isStringLiteral(nameArg) ? nameArg.value : "resource";
            const where = !fn ? "top-level module code"
                : t.isObjectMethod(fn.node) || t.isClassMethod(fn.node) ? "an object/class method"
                    : "a nested function / callback";
            throw new Error(`tierless: a tier call (${name}) inside ${where} is not supported — a callback runs synchronously inside native code (e.g. Array.map/sort) that cannot suspend or migrate. Lift it to a statement in a top-level function, e.g. \`for (const x of xs) { const r = ${name}(x); }\`.`);
        } });
}
// Collect the compilable top-level functions: plain FunctionDeclarations and NAMED exported
// ones (`export function f() {}`). Every other top-level statement (imports, consts, classes)
// is kept verbatim ahead of the output, so a "use tierless" module keeps its module scope. A file
// directive ("use tierless"/"use strict") is dropped — it addressed the build, not the runtime.
function collectProgram(ast) {
    const fnPaths = new Map(); // name -> { p, exported }
    const rest = [];
    for (const node of ast.program.body) {
        if (t.isFunctionDeclaration(node) && node.id) {
            fnPaths.set(node.id.name, { exported: false });
            continue;
        }
        if (t.isExportNamedDeclaration(node) && t.isFunctionDeclaration(node.declaration) && node.declaration.id) {
            fnPaths.set(node.declaration.id.name, { exported: true });
            continue;
        }
        if (t.isExpressionStatement(node) && t.isStringLiteral(node.expression) && node.expression.value.startsWith("use "))
            continue;
        rest.push(node);
    }
    traverse(ast, { FunctionDeclaration(p) {
            const name = p.node.id && p.node.id.name;
            const par = p.parentPath;
            if (!name || !fnPaths.has(name))
                return;
            if (t.isProgram(p.parent) || (par.isExportNamedDeclaration() && t.isProgram(par.parent)))
                fnPaths.get(name).p = p;
        } });
    // suspendability: directly contains a yield (tier resource), or transitively calls one that does
    const calls = new Map();
    const directly = new Set();
    for (const [name, { p }] of fnPaths) {
        let y = false;
        const cs = new Set();
        p.traverse({ YieldExpression() { y = true; }, CallExpression(cp) { const c = cp.node.callee; if (t.isIdentifier(c) && fnPaths.has(c.name))
                cs.add(c.name); } });
        if (y)
            directly.add(name);
        calls.set(name, cs);
    }
    const susp = new Set(directly);
    for (let changed = true; changed;) {
        changed = false;
        for (const [name, cs] of calls)
            if (!susp.has(name) && [...cs].some((c) => susp.has(c))) {
                susp.add(name);
                changed = true;
            }
    }
    return { fnPaths, rest, susp, directly, calls };
}
// The module's own top-level RELATIVE import/export-from specifiers (`./`, `../`), in source
// form. The compiled machine keeps these verbatim (they sit in `kept`); when the Vite plugin
// emits the server copy to a different directory it rewrites them relative to that directory
// (see vite.mts). Bare specifiers (packages) resolve from node_modules unchanged, so they're
// not listed.
function relativeImports(rest) {
    const specs = [];
    for (const n of rest) {
        const src = t.isImportDeclaration(n) || t.isExportNamedDeclaration(n) || t.isExportAllDeclaration(n) ? n.source : null;
        if (src && t.isStringLiteral(src) && src.value.startsWith("."))
            specs.push(src.value);
    }
    return [...new Set(specs)];
}
// ---- top-level class methods as PROGRAMS ------------------------------------------------
// The unit real apps actually write is the class method (service layers), so each method
// of a top-level named class that makes tier calls compiles into a PROGRAM named
// Cls$method, with the receiver as frame arg 0 (`this` -> __self, arrow-aware). The kept
// class's method becomes a stub routing through the module's bound method host
// (__bindTierlessMethods) and falling back to the untouched original — an unbound bundle
// behaves stock, byte for byte. Per-method and graceful: a method the compiler can't
// carry stays original and is reported in meta.methods with the reason.
function compileClassMethods(ast, progs, meta, rest) {
    const stubProps = []; // Cls.prototype.m.__tierless_program = "Cls$m" — what the dynamic call park dispatches on
    for (const top of ast.program.body) {
        const cls = t.isClassDeclaration(top) ? top
            : (t.isExportNamedDeclaration(top) || t.isExportDefaultDeclaration(top)) && t.isClassDeclaration(top.declaration) ? top.declaration
                : null;
        if (!cls)
            continue;
        if (!cls.id) {
            meta.methods.push({ class: "(default)", method: "*", program: null, error: "anonymous default-export class — name it to compile its methods" });
            continue;
        }
        const clsName = cls.id.name;
        let compiledAny = false;
        // sibling methods with DIRECT tier calls return promises by construction — a sync
        // wrapper's `return this.post(...)` may safely become a dyn park (see lowerMethod)
        const tierSiblings = new Set();
        for (const m of cls.body.body) {
            if (!t.isClassMethod(m) || !t.isIdentifier(m.key))
                continue;
            let hit = false;
            t.traverseFast(m, (n) => {
                if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && t.isMemberExpression(n.callee.object)
                    && t.isThisExpression(n.callee.object.object) && t.isIdentifier(n.callee.object.property) && TIER_OF["this." + n.callee.object.property.name])
                    hit = true;
            });
            if (hit)
                tierSiblings.add(m.key.name);
        }
        for (const m of [...cls.body.body]) {
            if (!t.isClassMethod(m) || m.kind !== "method" || m.static || m.computed || !t.isIdentifier(m.key))
                continue;
            const mName = m.key.name;
            const progName = clsName + "$" + mName;
            try {
                const prog = lowerMethod(clsName, mName, m, progName, tierSiblings);
                if (!prog)
                    continue; // no tier calls — stays a plain method
                progs.push(prog);
                meta.programs.push(progName);
                meta.methods.push({ class: clsName, method: mName, program: progName });
                // keep the original under a mangled name; the visible method becomes the stub.
                // A SYNC method (syncMethods) keeps its body: the routing stub returns a promise,
                // which a sync caller can't take — its machine runs when a compiled caller's
                // pump-dispatched call reaches it (by the program stamp below, or by class on a view)
                if (m.async) {
                    cls.body.body.push(t.classMethod("method", t.identifier("__tierless_orig_" + mName), m.params, m.body, false, false, false, m.async));
                    m.params = []; // stub reads `arguments`; original params would re-evaluate defaults
                    m.body = t.blockStatement([t.returnStatement(t.conditionalExpression(t.binaryExpression("===", t.unaryExpression("typeof", t.identifier("__TIERLESS_METHOD__")), t.stringLiteral("function")), t.callExpression(t.identifier("__TIERLESS_METHOD__"), [t.stringLiteral(progName), t.thisExpression(),
                            t.callExpression(t.memberExpression(t.identifier("Array"), t.identifier("from")), [t.identifier("arguments")])]), t.callExpression(t.memberExpression(t.thisExpression(), t.identifier("__tierless_orig_" + mName)), [t.spreadElement(t.identifier("arguments"))])))]);
                }
                // stamp the stub with its program name: a compiled CALLER's dynamic park reads it
                // to push this method as a nested machine instead of awaiting an opaque promise
                stubProps.push(t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.memberExpression(t.memberExpression(t.identifier(clsName), t.identifier("prototype")), t.identifier(mName)), t.identifier("__tierless_program")), t.stringLiteral(progName))));
                compiledAny = true;
            }
            catch (e) {
                meta.methods.push({ class: clsName, method: mName, program: null, error: e.message.split("\n")[0] });
            }
        }
        // class identity for §5: excision stamps it onto the handle (h.cls), so a dynamic
        // call park can dispatch to a session twin or this class's machine WITHOUT the live
        // instance (docs/migrate-arm.md "the dispatch problem")
        if (compiledAny)
            stubProps.push(t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.memberExpression(t.identifier(clsName), t.identifier("prototype")), t.identifier("__tierless_cls")), t.stringLiteral(clsName))));
    }
    rest.push(...stubProps); // `kept` is generated from rest — program-body pushes would never emit
}
// The `syncClosures` option. A library's factory method hands the app a closure over the
// instance (i18next's getFixedT returns `t`, closing over `this`, a key prefix and
// itself); a component captures `t`, and a migrated chain that calls it had to go home,
// because a native closure's environment can't be read. Compiled, the closure is a
// program plus explicit caps — the same shape a migrated method's stack has — so the
// codec can ship it (graph.mts "fn") and the far tier runs its own copy of the program.
// What makes the caps real over there is the SAME per-value rule as any migrated value:
// the instance ships whole when under the codec's threshold, else as a handle, and the
// stop rule (runtime.mts findHandle) sends the calling segment home in that case.
//
// Scope: `const NAME = <sync arrow|function>` statements directly in a class method's
// body. Captures are the method's bindings and module bindings the closure reads (a
// write to one can't be carried: the closure stays native); `this` captures as `__self`.
// Pass state shared by the two closure passes below (reset per compile)
let madeByPass = new WeakSet(); // function nodes the passes emit: never targets themselves
let takenNames = new Set();
const uniqName = (base) => { let n = base, i = 2; while (takenNames.has(n))
    n = base + "_" + i++; takenNames.add(n); return n; };
// every sync closure in a function body, INNERMOST FIRST (an outer closure's program then
// carries the inner one's stub), each replaced by its stub: a `const NAME = fn` keeps the
// statement form (the closure may name itself); any other position becomes an expression
// — (orig => stub)(fn). `selfOk`: an arrow's `this` here is an instance
function convertClosuresIn(body, owner, selfOk, report, progs, meta) {
    const made = madeByPass;
    const targets = [];
    body.traverse({ "ArrowFunctionExpression|FunctionExpression"(fp) { if (!made.has(fp.node))
            targets.push(fp); } });
    let anon = 0;
    for (const fp of targets.reverse()) { // pre-order reversed: a nested closure precedes the one that holds it
        const fn = fp.node;
        if (fn.async || fn.generator)
            continue;
        if (fp.parentPath.isCallExpression() && fp.parentPath.node.callee === fn)
            continue; // an IIFE
        const decl = fp.parentPath.isVariableDeclarator() && t.isIdentifier(fp.parentPath.node.id) ? fp.parentPath : null;
        const name = decl ? decl.node.id.name : fp.parentPath.isObjectProperty() && t.isIdentifier(fp.parentPath.node.key) ? fp.parentPath.node.key.name : "fn" + anon++;
        // `this` is the instance only through arrows all the way up to the method body
        let thisOk = selfOk;
        for (let a = fp.parentPath; a && a !== body; a = a.parentPath)
            if (a.isFunction() && !a.isArrowFunctionExpression()) {
                thisOk = false;
                break;
            }
        const progName = uniqName(`${owner}$${name}`);
        try {
            const captures = lowerSyncClosure(fp, thisOk, progName, report(name), progs, meta);
            const capsLit = t.objectExpression([
                ...(captures.self ? [t.objectProperty(t.identifier("__self"), t.thisExpression())] : []),
                ...captures.names.map((n) => t.objectProperty(t.identifier(n), t.identifier(n), false, true)),
            ]);
            const builder = t.arrowFunctionExpression([], capsLit);
            made.add(builder);
            if (decl) {
                const sp = decl.parentPath;
                const origName = "__tierless_orig_" + name;
                sp.insertBefore(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(origName), fn)]));
                const stub = t.arrowFunctionExpression([t.restElement(t.identifier("__tl_args"))], t.callExpression(t.identifier(origName), [t.spreadElement(t.identifier("__tl_args"))]));
                made.add(stub);
                decl.node.init = stub;
                sp.insertAfter([
                    t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier(name), t.identifier("__tierless_caps")), builder)),
                    t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier(name), t.identifier("__tierless_sync")), t.booleanLiteral(true))),
                    t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier(name), t.identifier("__tierless_program")), t.stringLiteral(progName))),
                ]);
            }
            else {
                const stub = t.arrowFunctionExpression([t.restElement(t.identifier("__tl_args"))], t.callExpression(t.identifier("__tl_orig"), [t.spreadElement(t.identifier("__tl_args"))]));
                made.add(stub);
                const wrap = t.arrowFunctionExpression([t.identifier("__tl_orig")], t.blockStatement([
                    t.variableDeclaration("const", [t.variableDeclarator(t.identifier("__tl_stub"), stub)]),
                    t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("__tl_stub"), t.identifier("__tierless_caps")), builder)),
                    t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("__tl_stub"), t.identifier("__tierless_sync")), t.booleanLiteral(true))),
                    t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("__tl_stub"), t.identifier("__tierless_program")), t.stringLiteral(progName))),
                    t.returnStatement(t.identifier("__tl_stub")),
                ]));
                made.add(wrap);
                fp.replaceWith(t.callExpression(wrap, [fn]));
            }
            meta.methods.push({ class: owner.split("$")[0], method: owner.split("$").slice(1).concat(name).join("."), program: progName });
        }
        catch (e) {
            meta.methods.push({ class: owner.split("$")[0], method: owner.split("$").slice(1).concat(name).join("."), program: null, error: e.message.split("\n")[0] });
        }
    }
}
// the top-level functions of the module: [path, name]
function moduleFunctions(ast) {
    const out = [];
    traverse(ast, { Function(fp) {
            const top = fp.isFunctionDeclaration() ? fp.parentPath : fp.parentPath.isVariableDeclarator() ? fp.parentPath.parentPath?.parentPath : null;
            const exported = top && top.isExportNamedDeclaration() ? top.parentPath : top;
            if (!top || !exported?.isProgram())
                return;
            const fname = fp.isFunctionDeclaration() ? fp.node.id?.name : t.isIdentifier(fp.parentPath.node.id) ? fp.parentPath.node.id.name : undefined;
            if (fname && !madeByPass.has(fp.node))
                out.push([fp, fname]);
            fp.skip();
        } });
    return out;
}
/** PASS 1 (before class methods compile, so their programs carry the stubs): the sync
 *  closures in every class method, constructor and module-level function become
 *  shippable stubs — in the kept code and, cloned from it, in the programs. */
function convertClosures(ast, progs, meta) {
    madeByPass = new WeakSet();
    takenNames = new Set(meta.programs);
    traverse(ast, { ClassDeclaration(cp) {
            const topLevel = cp.parentPath.isExportNamedDeclaration() ? !!cp.parentPath.parentPath?.isProgram() : cp.parentPath.isProgram();
            if (!cp.node.id || !topLevel)
                return;
            const clsName = cp.node.id.name;
            for (const mp of cp.get("body.body")) {
                if (!mp.isClassMethod() || !(mp.node.kind === "method" || mp.node.kind === "constructor") || mp.node.static || mp.node.computed || !t.isIdentifier(mp.node.key))
                    continue;
                const mName = mp.node.key.name;
                if (SYNC_CALLS)
                    inlineArrayCallbacks(mp); // loops first: an inline callback is the function's own code, not a closure
                convertClosuresIn(mp.get("body"), `${clsName}$${mName}`, true, (n) => `${clsName}.${mName}.${n}`, progs, meta);
            }
        } });
    for (const [fp, fname] of moduleFunctions(ast)) {
        if (SYNC_CALLS)
            inlineArrayCallbacks(fp);
        const body = fp.get("body");
        if (body.isBlockStatement() || body.isExpression())
            convertClosuresIn(body, fname, false, (n) => `${fname}.${n}`, progs, meta);
    }
}
/** PASS 2 (after): every top-level class gets a tier-independent identity (shareClass:
 *  a compiled class its bare name, any other module hash + name), and under syncMethods
 *  each module-level function becomes a program too, stamped on the function. */
function convertSyncClosures(ast, progs, meta, rest) {
    const moduleHash = fnv1a(gen(ast.program));
    const compiledClasses = new Set(meta.methods.filter((m) => m.program && !m.method.includes(".")).map((m) => m.class)); // classes with compiled METHODS (a closure's entry is "method.closure")
    const stamps = [];
    traverse(ast, { ClassDeclaration(cp) {
            const topLevel = cp.parentPath.isExportNamedDeclaration() ? !!cp.parentPath.parentPath?.isProgram() : cp.parentPath.isProgram();
            if (!cp.node.id || !topLevel)
                return;
            const clsName = cp.node.id.name;
            const clsId = compiledClasses.has(clsName) ? clsName : `${moduleHash}:${clsName}`;
            stamps.push(t.expressionStatement(t.callExpression(t.identifier("__tlShareClass"), [t.stringLiteral(clsId), t.identifier(clsName)])));
        } });
    if (SYNC_METHODS)
        for (const [fp, fname] of moduleFunctions(ast)) {
            if (fp.node.async || fp.node.generator || !(fp.isFunctionDeclaration() || fp.isArrowFunctionExpression() || fp.isFunctionExpression()))
                continue;
            if (meta.methods.some((m) => m.class === "fn:" + fname))
                continue; // a component: compileComponentFunctions owns it
            const progName = uniqName(fname);
            try {
                const captures = lowerSyncClosure(fp, false, progName, fname, progs, meta);
                const builder = t.arrowFunctionExpression([], t.objectExpression(captures.names.map((n) => t.objectProperty(t.identifier(n), t.identifier(n), false, true))));
                madeByPass.add(builder);
                stamps.push(t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier(fname), t.identifier("__tierless_caps")), builder)), t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier(fname), t.identifier("__tierless_sync")), t.booleanLiteral(true))), t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier(fname), t.identifier("__tierless_program")), t.stringLiteral(progName))));
                meta.methods.push({ class: "(module)", method: fname, program: progName });
            }
            catch (e) {
                meta.methods.push({ class: "(module)", method: fname, program: null, error: e.message.split("\n")[0] });
            }
        }
    if (!stamps.length)
        return;
    rest.unshift(t.importDeclaration([t.importSpecifier(t.identifier("__tlShareClass"), t.identifier("shareClass"))], t.stringLiteral("tierless/graph")));
    rest.push(...stamps);
}
// One sync closure -> program `prog(__caps, ...params)`: captured names read through
// __caps, `this` (the method's, through arrows) through __caps.__self. Returns what the
// kept stub must put in the caps literal.
function lowerSyncClosure(fnPath, selfOk, progName, label, progs, meta) {
    const fn = fnPath.node;
    const names = [];
    const seen = new Set();
    const within = (p, anc) => p === anc || !!p.findParent((q) => q === anc);
    fnPath.traverse({ ReferencedIdentifier(ip) {
            const name = ip.node.name;
            if (name === "arguments")
                throw new Error(`tierless: ${label} reads \`arguments\` — the closure stays native`);
            if (seen.has(name))
                return;
            const b = ip.scope.getBinding(name);
            if (!b || within(b.scope.path, fnPath))
                return; // its own local, or a true global
            // module-level CODE (a function or class declared or imported at module scope) is the
            // same on every tier that loads this module, where the program also lives: a free
            // reference, not a capture. Module-level DATA is captured like a method's local.
            if (b.scope.path.isProgram() && (b.kind === "hoisted" || b.kind === "module" || b.path.isClassDeclaration()
                || (b.kind === "const" && b.path.isVariableDeclarator() && (t.isFunction(b.path.node.init) || t.isClass(b.path.node.init)))))
                return;
            seen.add(name);
            names.push(name);
            for (const v of b.constantViolations)
                if (within(v, fnPath))
                    throw new Error(`tierless: ${label} assigns to captured binding '${name}' — a caps snapshot can't carry the write; the closure stays native`);
        } });
    let self = false;
    fnPath.traverse({ ThisExpression(tp) {
            let f = tp.getFunctionParent();
            while (f && f.isArrowFunctionExpression() && f.node !== fn)
                f = f.getFunctionParent();
            if (f && f.node === fn && t.isArrowFunctionExpression(fn))
                self = true; // an arrow's this is the method's
            else if (f && f.node === fn)
                throw new Error(`tierless: ${label} is a function expression using its own \`this\` — the closure stays native`);
        } });
    if (self && !selfOk)
        throw new Error(`tierless: ${label} captures \`this\` outside an instance method — the closure stays native`);
    const body = t.isBlockStatement(fn.body) ? t.cloneNode(fn.body, true) : t.blockStatement([t.returnStatement(t.cloneNode(fn.body, true))]);
    const fnNode = t.functionDeclaration(t.identifier(progName), [t.identifier("__caps"), ...fn.params.map((x) => t.cloneNode(x, true))], body);
    const file = t.file(t.program([fnNode]));
    const capSet = new Set(names);
    traverse(file, { ReferencedIdentifier(ip) {
            if (!capSet.has(ip.node.name) || ip.scope.getBinding(ip.node.name))
                return; // bound in the copy = shadowed
            ip.replaceWith(t.memberExpression(t.identifier("__caps"), t.identifier(ip.node.name)));
        } });
    traverse(file, { ThisExpression(tp) {
            let f = tp.getFunctionParent();
            while (f && f.isArrowFunctionExpression())
                f = f.getFunctionParent();
            if (f && f.node === fnNode)
                tp.replaceWith(t.memberExpression(t.identifier("__caps"), t.identifier("__self")));
        } });
    allowlist(file);
    rewriteDynAwaits(file, fnNode);
    if (SYNC_CALLS) {
        traverse(file, { FunctionDeclaration(fp) { if (fp.node === fnNode) {
                inlineArrayCallbacks(fp);
                fp.stop();
            } } });
        rewriteSyncCalls(file, fnNode);
    } // sync calls of values -> pump-dispatched parks
    traverse(file, { AwaitExpression(ap) {
            if (ap.getFunctionParent()?.node !== fnNode)
                return;
            throw new Error(`tierless: ${label} awaits (line ${ap.node.loc?.start.line ?? "?"}) — a sync closure can't; the closure stays native`);
        } });
    let mpath = null;
    traverse(file, { FunctionDeclaration(p) { if (p.node.id?.name === progName) {
            mpath = p;
            p.stop();
        } } });
    progs.push(lower(mpath));
    meta.programs.push(progName);
    return { names, self };
}
// Residual awaits of MEMBER CALLS become dynamic call parks (docs/migrate-arm.md
// slice 3): `await x.m(a)` -> `yield D(x, "m", a)` — resolved at RUNTIME by the pump.
// Shared by the method and store-function lowerings; awaits that survive it reject.
// Only awaits BELONGING to the lowered function rewrite (an await's owner is its nearest
// enclosing function, arrows included) — an await inside a nested function is that
// closure's own suspension: it stays plain JS, runs wherever its segment runs, and any
// escaping promise is ownedUnit, so the §5 stop rule fences it.
function rewriteDynAwaits(file, fnNode, freeFns) {
    traverse(file, { AwaitExpression(ap) {
            if (ap.getFunctionParent()?.node !== fnNode)
                return;
            const arg = ap.node.argument;
            // `await f(a)` where f is MODULE CODE the closure calls by name (lowerCapsUnit): the
            // call itself parks — the pump calls this tier's f where the run is
            if (t.isCallExpression(arg) && t.isIdentifier(arg.callee) && freeFns?.has(arg.callee.name) && !ap.scope.getBinding(arg.callee.name) && !arg.arguments.some((x) => t.isSpreadElement(x))) {
                const y = t.yieldExpression(t.callExpression(t.identifier("DF"), [arg.callee, t.stringLiteral(arg.callee.name), ...arg.arguments]));
                y.loc = ap.node.loc;
                ap.replaceWith(y);
                return;
            }
            if (t.isCallExpression(arg) && t.isMemberExpression(arg.callee) && !arg.callee.computed && t.isIdentifier(arg.callee.property) && !arg.arguments.some((x) => t.isSpreadElement(x))) {
                const y = t.yieldExpression(t.callExpression(t.identifier("D"), [arg.callee.object, t.stringLiteral(arg.callee.property.name), ...arg.arguments]));
                y.loc = ap.node.loc;
                ap.replaceWith(y);
            }
        } });
}
// ---- tracked binds (opts.syncClosures) --------------------------------------------------
// `x.bind(self, …)` anywhere in the module becomes bindTracked(x, self, [...]) (graph.mts):
// A local that a NESTED function assigns (`let found; keys.forEach(k => { found = … })`)
// can't ride a caps snapshot: a stub's caps copies the value at creation. BOX it — `let
// found = { v: undefined }`, every read `found.v`, every write `found.v = …` — so the
// closure captures the box (one object, shared with the frame through the graph) and
// its writes land where the function reads them. Only a simple `let` declarator written
// by plain assignments, updates or for-of/in heads qualifies; anything else keeps the
// closure native (lowerSyncClosure's check).
function boxCapturedWrites(ast) {
    traverse(ast, { Function(fp) {
            const scopes = new Set([fp.scope]);
            fp.traverse({ Scopable(sp) { if (sp.getFunctionParent()?.node === fp.node)
                    scopes.add(sp.scope); } });
            for (const sc of scopes)
                for (const name of Object.keys(sc.bindings)) {
                    const b = sc.bindings[name];
                    if (b.kind !== "let" || !b.path.isVariableDeclarator() || !t.isIdentifier(b.path.node.id))
                        continue;
                    if (!b.constantViolations.some((v) => v.getFunctionParent()?.node !== fp.node))
                        continue;
                    const plain = (v) => (v.isAssignmentExpression() && t.isIdentifier(v.node.left, { name })) || (v.isUpdateExpression() && t.isIdentifier(v.node.argument, { name })) || ((v.isForOfStatement() || v.isForInStatement()) && t.isIdentifier(v.node.left, { name }));
                    if (!b.constantViolations.every(plain))
                        continue;
                    const box = () => t.memberExpression(t.identifier(name), t.identifier("v"));
                    const decl = b.path.node;
                    decl.init = t.objectExpression([t.objectProperty(t.identifier("v"), decl.init ?? t.identifier("undefined"))]);
                    const refs = [];
                    for (const ref of b.referencePaths) {
                        if (ref.parentPath?.isObjectProperty() && ref.parentPath.node.shorthand && ref.parentPath.node.value === ref.node)
                            ref.parentPath.node.shorthand = false;
                        ref.replaceWith(box());
                        refs.push(ref.get("object"));
                    }
                    for (const v of b.constantViolations) {
                        if (v.isAssignmentExpression()) {
                            v.node.left = box();
                            refs.push(v.get("left.object"));
                        }
                        else if (v.isUpdateExpression()) {
                            v.node.argument = box();
                            refs.push(v.get("argument.object"));
                        }
                        else if (v.isForOfStatement() || v.isForInStatement()) {
                            v.node.left = box();
                            refs.push(v.get("left.object"));
                        }
                    }
                    // the binding is a constant now (the box never changes); its references are the boxes' objects
                    b.referencePaths = refs;
                    b.constantViolations = [];
                    b.constant = true;
                }
        } });
}
// a bound method of a shared class then ships as the method by name plus its receiver
// and args, and runs off-tier as the class's program over the receiver's view — the
// i18next idiom (bindMemberFunctions) made shippable without guessing from names.
function rewriteBinds(ast, rest) {
    let n = 0;
    traverse(ast, { CallExpression(cp) {
            const c = cp.node.callee;
            if (!t.isMemberExpression(c) || c.computed || !t.isIdentifier(c.property, { name: "bind" }) || !cp.node.arguments.length || cp.node.arguments.some((a) => t.isSpreadElement(a)))
                return;
            if (t.isSuper(c.object))
                return;
            const [self, ...args] = cp.node.arguments;
            cp.replaceWith(t.callExpression(t.identifier("__tlBind"), [c.object, self, t.arrayExpression(args)]));
            n++;
        } });
    if (n)
        rest.unshift(t.importDeclaration([t.importSpecifier(t.identifier("__tlBind"), t.identifier("bindTracked"))], t.stringLiteral("tierless/graph")));
}
// ---- inline array callbacks as loops (opts.syncCalls) -----------------------------------
// `xs.forEach(x => …)`, map, filter, some, every, find, findIndex, reduce with an INLINE
// callback: the callback's body runs natively inside the segment, so a `this.m()` in it
// can't park and sends the whole receiver home. Lowered into a loop over the array (the
// body becomes the function's own code, under the stop rule and the sync-call rewrite),
// guarded by Array.isArray — any other receiver (a Map, a NodeList) keeps the native call.
// Only at statement level, as `const v = …`, `v = …` or `return …`; a callback using its
// own `this`/`arguments`, async, or with a thisArg stays native.
let cbCounter = 0;
function inlineArrayCallbacks(fnPath) {
    const fnNode = fnPath.node;
    const METHODS = new Set(["forEach", "map", "filter", "some", "every", "find", "findIndex", "reduce"]);
    const fresh = () => "__cb" + cbCounter++;
    const nativeKept = new WeakSet(); // the fallback calls this pass emits: not candidates again
    for (let guard = 0; guard < 10000; guard++) {
        let acted = false;
        fnPath.traverse({ CallExpression(cp) {
                if (acted || cp.getFunctionParent()?.node !== fnNode || nativeKept.has(cp.node))
                    return;
                const c = cp.node.callee;
                if (!t.isMemberExpression(c) || c.computed || !t.isIdentifier(c.property) || !METHODS.has(c.property.name))
                    return;
                const method = c.property.name, args = cp.node.arguments;
                const cb = args[0];
                if (!cb || !(t.isArrowFunctionExpression(cb) || t.isFunctionExpression(cb)) || cb.async || cb.generator)
                    return;
                if (args.length !== (method === "reduce" ? 2 : 1))
                    return;
                if (cb.params.length > (method === "reduce" ? 3 : 2) || cb.params.some((q) => !(t.isIdentifier(q) || t.isArrayPattern(q) || t.isObjectPattern(q))))
                    return;
                const cbPath = cp.get("arguments.0");
                let bad = false;
                cbPath.traverse({
                    ThisExpression(tp) { if (t.isFunctionExpression(cb)) {
                        let f = tp.getFunctionParent();
                        while (f && f.isArrowFunctionExpression())
                            f = f.getFunctionParent();
                        if (f?.node === cb)
                            bad = true;
                    } },
                    Identifier(ip) { if (ip.node.name === "arguments" && ip.getFunctionParent()?.node === cb)
                        bad = true; },
                    YieldExpression() { bad = true; },
                });
                if (bad)
                    return;
                const par = cp.parentPath;
                let kind;
                if (par.isExpressionStatement())
                    kind = "stmt";
                else if (par.isVariableDeclarator() && par.node.init === cp.node && t.isIdentifier(par.node.id) && par.parentPath.node.declarations.length === 1)
                    kind = "decl";
                else if (par.isAssignmentExpression() && par.node.right === cp.node && par.node.operator === "=" && t.isIdentifier(par.node.left) && par.parentPath.isExpressionStatement())
                    kind = "assign";
                else if (par.isReturnStatement())
                    kind = "return";
                else
                    return;
                // the callback's own names must not alias the function's: rename on clash
                const fnScope = cbPath.scope.getFunctionParent().parent; // the enclosing function's scope (through the callback's own)
                for (const name of Object.keys(cbPath.scope.bindings))
                    if (fnScope.hasBinding(name))
                        cbPath.scope.rename(name, fresh() + "_" + name);
                cbPath.traverse({ Scopable(sp) { for (const name of Object.keys(sp.scope.bindings))
                        if (sp.scope !== cbPath.scope && fnScope.hasBinding(name))
                            sp.scope.rename(name, fresh() + "_" + name); } });
                const a = fresh(), i = fresh(), r = fresh();
                const [q0, q1, q2] = cb.params;
                const accP = method === "reduce" ? q0 : undefined, itemP = method === "reduce" ? q1 : q0, idxP = method === "reduce" ? q2 : q1;
                const itemId = itemP && t.isIdentifier(itemP) ? itemP.name : fresh();
                const item = () => t.identifier(itemId);
                const assign = (name, e) => t.expressionStatement(t.assignmentExpression("=", t.identifier(name), e));
                const push = (e) => t.expressionStatement(t.callExpression(t.memberExpression(t.identifier(r), t.identifier("push")), [e]));
                const brk = () => t.breakStatement(), cont = () => t.continueStatement();
                const undef = () => t.identifier("undefined");
                const onReturn = (e) => {
                    const v = e ?? undef();
                    switch (method) {
                        case "forEach": return [cont()];
                        case "map": return [push(v), cont()];
                        case "filter": return [t.ifStatement(v, push(item())), cont()];
                        case "some": return [t.ifStatement(v, t.blockStatement([assign(r, t.booleanLiteral(true)), brk()])), cont()];
                        case "every": return [t.ifStatement(t.unaryExpression("!", v), t.blockStatement([assign(r, t.booleanLiteral(false)), brk()])), cont()];
                        case "find": return [t.ifStatement(v, t.blockStatement([assign(r, item()), brk()])), cont()];
                        case "findIndex": return [t.ifStatement(v, t.blockStatement([assign(r, t.identifier(i)), brk()])), cont()];
                        default: return [assign(accP.name, v), cont()]; // reduce
                    }
                };
                const body = t.isBlockStatement(cb.body) ? t.cloneNode(cb.body, true) : t.blockStatement([t.returnStatement(t.cloneNode(cb.body, true))]);
                const wrapper = t.functionDeclaration(t.identifier("__w"), [], body);
                traverse(t.file(t.program([wrapper])), { ReturnStatement(rp) { if (rp.getFunctionParent()?.node === wrapper)
                        rp.replaceWithMultiple(onReturn(rp.node.argument ?? null)); } });
                const loopBody = [];
                if (itemP)
                    loopBody.push(t.variableDeclaration("const", [t.variableDeclarator(t.isIdentifier(itemP) ? t.identifier(itemId) : itemP, t.memberExpression(t.identifier(a), t.identifier(i), true))]));
                if (idxP && t.isIdentifier(idxP))
                    loopBody.push(t.variableDeclaration("const", [t.variableDeclarator(idxP, t.identifier(i))]));
                loopBody.push(...wrapper.body.body, ...onReturn(null).filter((st) => !t.isContinueStatement(st))); // falling off the end returns undefined
                const loop = t.forStatement(t.variableDeclaration("let", [t.variableDeclarator(t.identifier(i), t.numericLiteral(0))]), t.binaryExpression("<", t.identifier(i), t.memberExpression(t.identifier(a), t.identifier("length"))), t.updateExpression("++", t.identifier(i)), t.blockStatement(loopBody));
                const init = method === "map" || method === "filter" ? [t.variableDeclaration("const", [t.variableDeclarator(t.identifier(r), t.arrayExpression([]))])]
                    : method === "some" ? [t.variableDeclaration("let", [t.variableDeclarator(t.identifier(r), t.booleanLiteral(false))])]
                        : method === "every" ? [t.variableDeclaration("let", [t.variableDeclarator(t.identifier(r), t.booleanLiteral(true))])]
                            : method === "find" ? [t.variableDeclaration("let", [t.variableDeclarator(t.identifier(r), undef())])]
                                : method === "findIndex" ? [t.variableDeclaration("let", [t.variableDeclarator(t.identifier(r), t.unaryExpression("-", t.numericLiteral(1)))])]
                                    : method === "reduce" ? [t.variableDeclaration("let", [t.variableDeclarator(t.identifier(accP.name), args[1])])] : [];
                const result = () => (method === "reduce" ? t.identifier(accP.name) : t.identifier(r));
                const target = kind === "decl" ? par.node.id : kind === "assign" ? par.node.left : kind === "return" ? t.identifier(fresh()) : null;
                const arrayBranch = t.blockStatement([...init, loop, ...(target && method !== "forEach" ? [assign(target.name, result())] : [])]);
                const native = t.callExpression(t.memberExpression(t.identifier(a), t.identifier(method)), [cb, ...args.slice(1)]);
                nativeKept.add(native);
                const nativeBranch = target && method !== "forEach" ? assign(target.name, native) : t.expressionStatement(native);
                const block = t.blockStatement([
                    t.variableDeclaration("const", [t.variableDeclarator(t.identifier(a), c.object)]),
                    t.ifStatement(t.callExpression(t.memberExpression(t.identifier("Array"), t.identifier("isArray")), [t.identifier(a)]), arrayBranch, nativeBranch),
                ]);
                const stmt = cp.getStatementParent();
                if (kind === "decl")
                    stmt.replaceWithMultiple([t.variableDeclaration("let", [t.variableDeclarator(t.identifier(target.name))]), block]);
                else if (kind === "return")
                    stmt.replaceWithMultiple([t.variableDeclaration("let", [t.variableDeclarator(t.identifier(target.name))]), block, t.returnStatement(t.identifier(target.name))]);
                else
                    stmt.replaceWith(block);
                acted = true;
                cp.stop();
            } });
        if (!acted)
            break;
    }
}
// ---- sync calls of VALUES as pump-dispatched parks (opts.syncCalls) ----------------------
// A call whose callee is a value the segment holds — a captured function (`t(k)`), a
// method of `this` or of a local (`this.translate(k)`, `lib.get(k)`) — lowers like an
// awaited member call (rewriteDynAwaits): the pump resolves it where the run is — a
// shipped closure's or a compiled class's program as a sub-frame (so the stop rule covers
// ITS segments), a session twin, a native call on a live object — or parks the call home
// with the view. Calls to module code (a module-level function, an import, a global) and
// calls inside nested functions stay plain JS. The pump never awaits a sync call.
// a local const bound to an arrow function — as written, or as the stub wrapper a
// converted closure left in its place (`(__tl_orig => …)(x => …)`)
function arrowBound(cp, name, fnNode) {
    const b = cp.scope.getBinding(name);
    if (!b || b.kind !== "const" || !b.path.isVariableDeclarator() || b.scope.getFunctionParent()?.path.node !== fnNode)
        return false;
    const init = b.path.node.init;
    return t.isArrowFunctionExpression(init) || (t.isCallExpression(init) && t.isArrowFunctionExpression(init.callee) && init.arguments.length === 1 && t.isArrowFunctionExpression(init.arguments[0]));
}
function rewriteSyncCalls(file, fnNode) {
    const SPECIAL = new Set(["R", "D", "DF", "DS", "DSO", "C", "deref"]);
    traverse(file, { CallExpression(cp) {
            if (cp.getFunctionParent()?.node !== fnNode)
                return; // a nested function's call: plain JS
            if (cp.parentPath.isYieldExpression() || cp.parentPath.isAwaitExpression())
                return; // a suspension already; an awaited value stays an await
            const c = cp.node.callee;
            // a param or local of THIS function (captures are __caps members by now); anything
            // else bound outside, or unbound, is module code or a global
            const localValue = (name) => { const b = cp.scope.getBinding(name); return !!b && b.scope.getFunctionParent()?.path.node === fnNode; };
            let y;
            if (t.isIdentifier(c)) {
                if (SPECIAL.has(c.name) || suspSet.has(c.name))
                    return;
                // a module-level function: plain code — unless syncMethods compiles it too, when its
                // program runs as a sub-frame (a view argument is then read under the stop rule)
                if (!localValue(c.name) && !(SYNC_METHODS && MODULE_FNS.has(c.name) && !cp.scope.getBinding(c.name)))
                    return; // unbound in the lowered copy = the module's
                y = t.yieldExpression(t.callExpression(t.identifier("C"), [c, ...cp.node.arguments]));
            }
            else if (t.isMemberExpression(c) && !c.computed && t.isIdentifier(c.property) && t.isIdentifier(c.object, { name: "__caps" })) {
                // a captured function called bare in the source (`t(k)` -> `__caps.t(k)`): a call of
                // the VALUE, with no receiver — not a method of the caps object
                y = t.yieldExpression(t.callExpression(t.identifier("C"), [c, ...cp.node.arguments]));
            }
            else if (t.isMemberExpression(c) && !c.computed && t.isIdentifier(c.object) && t.isIdentifier(c.property) && (c.property.name === "call" || c.property.name === "apply") && arrowBound(cp, c.object.name, fnNode)) {
                // `f.call(this, a)` / `f.apply(this, xs)` on a local ARROW: an arrow has no `this` of
                // its own, so the thisArg is noise — a plain call of the value (its program, when
                // it compiled)
                const [, ...rest] = cp.node.arguments;
                const args = c.property.name === "call" ? rest : rest.length ? [t.spreadElement(rest[0])] : [];
                y = t.yieldExpression(t.callExpression(t.identifier("C"), [c.object, ...args]));
            }
            else if (t.isMemberExpression(c) && (c.computed ? !t.isPrivateName(c.property) : t.isIdentifier(c.property))) {
                const o = c.object;
                if (t.isSuper(o))
                    return;
                if (t.isIdentifier(o) && !localValue(o.name))
                    return; // a module object's or a global's method (Object.keys, JSON.parse, a module-level helper)
                if (!(t.isThisExpression(o) || t.isIdentifier(o) || t.isMemberExpression(o) || t.isCallExpression(o)))
                    return; // a literal's method: native
                const member = c.computed ? c.property : t.stringLiteral(c.property.name); // `o[k](…)`: the member is a value
                y = t.yieldExpression(t.callExpression(t.identifier("DS"), [o, member, ...cp.node.arguments]));
            }
            else
                return;
            y.loc = cp.node.loc;
            cp.replaceWith(y);
        },
        // `o?.m(a)` — the same park, guarded: `o == null ? undefined : yield DS(o, "m", a)`. Only
        // when `o` is a side-effect-free chain (this, a local, their members), which re-evaluates
        // safely; anything else stays native (and the stop rule still fences a view receiver)
        OptionalCallExpression(cp) {
            if (cp.getFunctionParent()?.node !== fnNode)
                return;
            if (cp.parentPath.isYieldExpression() || cp.parentPath.isAwaitExpression())
                return;
            const c = cp.node.callee;
            if (!(t.isOptionalMemberExpression(c) || t.isMemberExpression(c)) || c.computed || !t.isIdentifier(c.property))
                return; // `o.m?.()` has a plain member callee; `o?.m()` an optional one
            const o = c.object;
            if (t.isIdentifier(o)) {
                const b = cp.scope.getBinding(o.name);
                if (!b || b.scope.getFunctionParent()?.path.node !== fnNode)
                    return;
            } // a module object's optional method: native
            if (cp.node.optional && !(t.isOptionalMemberExpression(c) && c.optional)) { // `o.m?.(a)`: guards the MEMBER — the pump answers undefined when it is null
                const y = t.yieldExpression(t.callExpression(t.identifier("DSO"), [o, t.stringLiteral(c.property.name), ...cp.node.arguments]));
                y.loc = cp.node.loc;
                cp.replaceWith(y);
                return;
            }
            const pure = (e) => t.isThisExpression(e) || t.isIdentifier(e) || ((t.isMemberExpression(e) || t.isOptionalMemberExpression(e)) && !e.computed && pure(e.object));
            if (!pure(o))
                return;
            const guard = t.binaryExpression("==", t.cloneNode(o, true), t.nullLiteral());
            const y = t.yieldExpression(t.callExpression(t.identifier("DS"), [o, t.stringLiteral(c.property.name), ...cp.node.arguments]));
            y.loc = cp.node.loc;
            cp.replaceWith(t.conditionalExpression(guard, t.identifier("undefined"), y));
        } });
}
/** Lower one closure unit; returns its captures, or null when it has too few parks.
 *  Throws (with the reason) when the function can't be carried. */
function lowerCapsUnit(u, progs, meta) {
    const fn = u.fnPath.node;
    const label = `${u.owner.replace(/^\w+:/, "")}.${u.fnName}`;
    // free bindings — the caps. EVERYTHING bound outside the function captures: closure
    // refs and services, and MODULE-scope imports/consts alike. Module singletons (a
    // router, i18n, a base store) are browser-owned live values the slot rule couldn't
    // fence as imports — through the caps handle they fence like any owned slot, and the
    // machine's server bundle needs (almost) no app imports. An ASSIGNMENT to a captured
    // binding can't be carried (the caps object is a snapshot of bindings, not the
    // bindings themselves) — the function stays original.
    const captures = [];
    const seen = new Set();
    const free = new Set();
    const within = (p, anc) => p === anc || !!p.findParent((q) => q === anc);
    const importAllowed = (b) => { const decl = b.path.parentPath?.node; return MODULE_CODE === true || (Array.isArray(MODULE_CODE) && t.isImportDeclaration(decl) && MODULE_CODE.includes(decl.source.value)); };
    const safeTop = new Map();
    const safeAtTop = (b) => {
        if (b.kind === "module")
            return importAllowed(b);
        if (!b.scope.path.isProgram())
            return false;
        const hit = safeTop.get(b);
        if (hit !== undefined)
            return hit;
        safeTop.set(b, true); // a cycle through itself is fine
        let ok = true;
        const decl = b.path;
        decl.traverse({
            ReferencedIdentifier(ip) {
                if (!ok)
                    return;
                const ib = ip.scope.getBinding(ip.node.name);
                if (!ib || within(ib.scope.path, decl))
                    return; // its own local, or a global
                if (!safeAtTop(ib))
                    ok = false;
            },
            "JSXElement|JSXFragment"() { ok = false; },
        });
        safeTop.set(b, ok);
        return ok;
    };
    const moduleCode = (b) => {
        if (MODULE_CODE === false)
            return false;
        if (b.kind === "module")
            return importAllowed(b); // an import: any source, or one the build vetted as loadable off the browser (vite.mts serverSafe)
        return b.scope.path.isProgram() && (b.kind === "hoisted" || b.path.isClassDeclaration()
            || (b.kind === "const" && b.path.isVariableDeclarator() && (t.isFunction(b.path.node.init) || t.isClass(b.path.node.init)))) && safeAtTop(b);
    };
    const onlyCalled = (b) => b.referencePaths.filter((r) => within(r, u.fnPath)).every((r) => r.parentPath?.isCallExpression() && r.parentPath.node.callee === r.node);
    u.fnPath.traverse({ ReferencedIdentifier(ip) {
            const name = ip.node.name;
            if (name === "arguments" && t.isArrowFunctionExpression(fn) && ip.getFunctionParent()?.node === fn)
                throw new Error(`tierless: ${label} reads the enclosing function's \`arguments\` — an arrow can't carry it; the function stays uncompiled`);
            if (seen.has(name))
                return;
            const b = ip.scope.getBinding(name);
            if (!b || within(b.scope.path, u.fnPath))
                return; // fn-local or a true global: stays as-is
            if (MODULE_CODE && moduleCode(b) && onlyCalled(b)) {
                seen.add(name);
                free.add(name);
                return;
            }
            seen.add(name);
            captures.push(name);
            for (const v of b.constantViolations)
                if (within(v, u.fnPath))
                    throw new Error(`tierless: ${label} assigns to captured binding '${name}' — a caps snapshot can't carry the write; the function stays uncompiled`);
        } });
    // isolated machine copy: function prog(__caps, ...params) { body }, captures rewritten
    // to __caps.<name> — precisely, via the isolated file's own scope (a nested shadowing
    // declaration keeps its local meaning). A concise arrow body becomes `return <expr>`.
    const body = t.isBlockStatement(fn.body) ? t.cloneNode(fn.body, true) : t.blockStatement([t.returnStatement(t.cloneNode(fn.body, true))]);
    const fnNode = t.functionDeclaration(t.identifier(u.progName), [t.identifier("__caps"), ...fn.params.map((x) => t.cloneNode(x, true))], body);
    const file = t.file(t.program([fnNode]));
    const capSet = new Set(captures);
    traverse(file, { ReferencedIdentifier(ip) {
            if (!capSet.has(ip.node.name) || ip.scope.getBinding(ip.node.name))
                return; // bound in the copy = shadowed
            ip.replaceWith(t.memberExpression(t.identifier("__caps"), t.identifier(ip.node.name)));
        } });
    allowlist(file);
    rewriteDynAwaits(file, fnNode, free);
    let yields = 0;
    traverse(file, { YieldExpression(yp) { if (isResYield(yp.node) || isAsyncDynYield(yp.node))
            yields++; } });
    if (yields < u.minParks)
        return null; // too few tier-reaching awaits: stays a plain function
    if (SYNC_CALLS) {
        traverse(file, { FunctionDeclaration(fp) { if (fp.node === fnNode) {
                inlineArrayCallbacks(fp);
                fp.stop();
            } } });
        rewriteSyncCalls(file, fnNode);
    } // sync calls of values -> pump-dispatched parks
    traverse(file, { ThisExpression(tp) {
            throw new Error(`tierless: ${label} uses \`this\` (line ${tp.node.loc?.start.line ?? "?"}) — a closure function has no instance; the function stays uncompiled`);
        } });
    traverse(file, { "JSXElement|JSXFragment"(jp) {
            throw new Error(`tierless: ${label} builds JSX (line ${jp.node.loc?.start.line ?? "?"}) — rendering stays with the app's own pipeline; the function stays uncompiled`);
        } });
    traverse(file, { AwaitExpression(ap) {
            if (ap.getFunctionParent()?.node !== fnNode)
                return; // a nested closure's own await: plain JS, stays
            throw new Error(`tierless: ${label} awaits a non-call value (line ${ap.node.loc?.start.line ?? "?"}) — a pending native promise can't migrate; the function stays uncompiled`);
        } });
    let mpath = null;
    traverse(file, { FunctionDeclaration(p) { if (p.node.id?.name === u.progName) {
            mpath = p;
            p.stop();
        } } });
    progs.push(lower(mpath));
    meta.programs.push(u.progName);
    meta.methods.push({ class: u.owner, method: u.fnName, program: u.progName });
    return captures;
}
// the routing stub's body: the bound runtime runs the program over a CALL-TIME caps
// literal from the live closure; unbound, the untouched original runs
const stubCall = (progName, capsLit, argv, orig, spread) => t.conditionalExpression(t.binaryExpression("===", t.unaryExpression("typeof", t.identifier("__TIERLESS_METHOD__")), t.stringLiteral("function")), t.callExpression(t.identifier("__TIERLESS_METHOD__"), [t.stringLiteral(progName), capsLit, argv]), t.callExpression(t.identifier(orig), [t.spreadElement(spread)]));
// the stamps a compiled CALLER's dynamic park dispatches on (sibling calls), and the CAPS
// BUILDER for that dispatch: a sibling's frame arg 0 is ITS OWN caps, which only this
// closure can build — a caller's dyn park must not hand the sibling the caller's caps
// (checkAuth reading login's caps was the vikunja auth cluster)
const stamps = (fnName, progName, capsLit) => [
    t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier(fnName), t.identifier("__tierless_program")), t.stringLiteral(progName))),
    t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier(fnName), t.identifier("__tierless_caps")), t.arrowFunctionExpression([], t.cloneNode(capsLit)))),
];
const capsLiteral = (captures) => t.objectExpression(captures.map((n) => t.objectProperty(t.identifier(n), t.identifier(n), false, true)));
/** Compile an `async function f` statement in place: the visible function becomes the stub
 *  (function declarations hoist, so no declaration-order constraints). */
function compileDeclUnit(stmtPath, owner, progName, minParks, progs, meta) {
    const fnName = stmtPath.node.id.name;
    try {
        const captures = lowerCapsUnit({ owner, fnName, progName, fnPath: stmtPath, minParks }, progs, meta);
        if (!captures)
            return;
        const origName = "__tierless_orig_" + fnName;
        const orig = t.functionDeclaration(t.identifier(origName), stmtPath.node.params, stmtPath.node.body, false, stmtPath.node.async);
        const capsLit = capsLiteral(captures);
        stmtPath.node.params = [];
        stmtPath.node.body = t.blockStatement([t.returnStatement(stubCall(progName, capsLit, t.callExpression(t.memberExpression(t.identifier("Array"), t.identifier("from")), [t.identifier("arguments")]), origName, t.identifier("arguments")))]);
        stmtPath.insertAfter([orig, ...stamps(fnName, progName, capsLit)]);
    }
    catch (e) {
        meta.methods.push({ class: owner, method: fnName, program: null, error: e.message.split("\n")[0] });
    }
}
/** Compile `const f = async (...) => ...` (or an async function expression) in place: the
 *  original moves to a const declared just before, the declarator becomes a rest-param
 *  stub (an arrow has no `arguments`), and the stamps follow the statement. */
function compileConstUnit(declPath, owner, progName, minParks, progs, meta) {
    const fnName = declPath.node.id.name;
    const initPath = declPath.get("init");
    try {
        const captures = lowerCapsUnit({ owner, fnName, progName, fnPath: initPath, minParks }, progs, meta);
        if (!captures)
            return;
        const origName = "__tierless_orig_" + fnName;
        const stmt = declPath.parentPath;
        stmt.insertBefore(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(origName), initPath.node)]));
        const capsLit = capsLiteral(captures);
        declPath.node.init = t.arrowFunctionExpression([t.restElement(t.identifier("__tl_args"))], stubCall(progName, capsLit, t.identifier("__tl_args"), origName, t.identifier("__tl_args")));
        stmt.insertAfter(stamps(fnName, progName, capsLit));
    }
    catch (e) {
        meta.methods.push({ class: owner, method: fnName, program: null, error: e.message.split("\n")[0] });
    }
}
/** Compile an async function passed straight to a call — `useFetch(async () => {...}, set, deps)`
 *  — in place: the original moves to a const declared before the statement, and the
 *  argument becomes a rest-param stub over it. Anonymous, so no sibling stamps: nothing can
 *  name it to call it from compiled code. */
function compileArgUnit(stmtPath, argPath, owner, progName, minParks, progs, meta) {
    const fnName = progName.slice(progName.indexOf("$") + 1);
    try {
        const captures = lowerCapsUnit({ owner, fnName, progName, fnPath: argPath, minParks }, progs, meta);
        if (!captures)
            return;
        const origName = "__tierless_orig_" + progName.replace(/\$/g, "_");
        stmtPath.insertBefore(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(origName), argPath.node)]));
        argPath.replaceWith(t.arrowFunctionExpression([t.restElement(t.identifier("__tl_args"))], stubCall(progName, capsLiteral(captures), t.identifier("__tl_args"), origName, t.identifier("__tl_args"))));
    }
    catch (e) {
        meta.methods.push({ class: owner, method: fnName, program: null, error: e.message.split("\n")[0] });
    }
}
function compileStoreFunctions(ast, progs, meta) {
    traverse(ast, { CallExpression(csp) {
            if (!t.isIdentifier(csp.node.callee, { name: "defineStore" }))
                return;
            const keyArg = csp.node.arguments[0];
            const setup = csp.get("arguments.1");
            if (!t.isStringLiteral(keyArg) || !(setup.isArrowFunctionExpression() || setup.isFunctionExpression()))
                return;
            const storeKey = keyArg.value.replace(/[^A-Za-z0-9_$]/g, "_");
            const body = setup.get("body");
            if (!body || Array.isArray(body) || !body.isBlockStatement())
                return;
            for (const stmtPath of body.get("body")) {
                if (!stmtPath.isFunctionDeclaration() || !stmtPath.node.async || !stmtPath.node.id)
                    continue;
                compileDeclUnit(stmtPath, "store:" + storeKey, storeKey + "$" + stmtPath.node.id.name, 1, progs, meta);
            }
        } });
}
// A component or hook: a TOP-LEVEL function (declared, or a const arrow/function
// expression, exported or not) whose body declares async functions. Only statements
// directly in its body are units — a callback nested deeper is plain JS.
function compileComponentFunctions(ast, progs, meta, skip) {
    traverse(ast, { Program(pp) {
            const containers = [];
            for (let sp of pp.get("body")) {
                if ((sp.isExportNamedDeclaration() || sp.isExportDefaultDeclaration()) && sp.node.declaration)
                    sp = sp.get("declaration");
                if (sp.isFunctionDeclaration())
                    containers.push([sp.node.id?.name ?? "default", sp]);
                else if (sp.isVariableDeclaration()) {
                    for (const d of sp.get("declarations")) {
                        const init = d.get("init");
                        if (t.isIdentifier(d.node.id) && !Array.isArray(init) && (init.isArrowFunctionExpression() || init.isFunctionExpression()))
                            containers.push([d.node.id.name, init]);
                    }
                }
            }
            for (const [name, cp] of containers) {
                if (skip.has(name))
                    continue; // compiled whole as a program already
                const body = cp.get("body");
                if (!body.isBlockStatement())
                    continue;
                const owner = "fn:" + name;
                const argCount = new Map();
                for (const stmtPath of body.get("body")) {
                    // async functions passed straight to a hook call: `useFetch(async () => {...}, ...)` as
                    // a statement, or as a declarator's init (`const x = useQuery(async () => ...)`)
                    const calls = [];
                    if (stmtPath.isExpressionStatement() && stmtPath.get("expression").isCallExpression())
                        calls.push(stmtPath.get("expression"));
                    if (stmtPath.isVariableDeclaration())
                        for (const d of stmtPath.get("declarations")) {
                            const i = d.get("init");
                            if (!Array.isArray(i) && i.isCallExpression())
                                calls.push(i);
                        }
                    for (const cp of calls) {
                        if (!t.isIdentifier(cp.node.callee))
                            continue;
                        const callee = cp.node.callee.name;
                        for (const ap of cp.get("arguments")) {
                            if (!(ap.isArrowFunctionExpression() || ap.isFunctionExpression()) || !ap.node.async)
                                continue;
                            const n = argCount.get(callee) ?? 0;
                            argCount.set(callee, n + 1);
                            compileArgUnit(stmtPath, ap, owner, `${name}$${callee}${n}`, 2, progs, meta);
                        }
                    }
                    if (stmtPath.isFunctionDeclaration() && stmtPath.node.async && stmtPath.node.id) {
                        compileDeclUnit(stmtPath, owner, name + "$" + stmtPath.node.id.name, 2, progs, meta);
                    }
                    else if (stmtPath.isVariableDeclaration()) {
                        for (const d of stmtPath.get("declarations")) {
                            const init = d.node.init;
                            if (t.isIdentifier(d.node.id) && (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) && init.async) {
                                compileConstUnit(d, owner, name + "$" + d.node.id.name, 2, progs, meta);
                            }
                        }
                    }
                }
            }
            pp.stop();
        } });
}
// Lower ONE method in isolation: synthesize `function Cls$m(__self, ...params) { body }`
// in its own File, rewrite `this` (through arrows — they share the method's this; not
// through nested functions — they have their own), run the allow-list on it (which also
// absorbs `await` around tier calls), and reject what can't migrate with a precise
// reason. Returns null when the method makes no tier calls at all.
function lowerMethod(clsName, mName, m, progName, tierSiblings = new Set()) {
    const fnNode = t.functionDeclaration(t.identifier(progName), [t.identifier("__self"), ...m.params.map((x) => t.cloneNode(x, true))], t.cloneNode(m.body, true));
    const file = t.file(t.program([fnNode]));
    allowlist(file); // recognizes both this.<ns> and __self.<ns>, so it can run before the this-rewrite
    rewriteDynAwaits(file, fnNode); // awaited member calls -> dynamic parks; bare awaits still reject below
    if (SYNC_CALLS) {
        traverse(file, { FunctionDeclaration(fp) { if (fp.node === fnNode) {
                inlineArrayCallbacks(fp);
                fp.stop();
            } } });
        rewriteSyncCalls(file, fnNode);
    } // sync calls of values -> pump-dispatched parks
    // a WRAPPER's `return this.m(...)` where m is a tier-calling sibling: the callee is
    // promise-returning by construction, so the tail joins the run as a dyn park — the
    // chains real services build out of delegation (update -> post) stay ONE traced run.
    traverse(file, { ReturnStatement(rp) {
            if (rp.getFunctionParent()?.node !== fnNode)
                return;
            const arg = rp.node.argument;
            if (t.isCallExpression(arg) && t.isMemberExpression(arg.callee) && !arg.callee.computed && t.isIdentifier(arg.callee.property)
                && tierSiblings.has(arg.callee.property.name)
                && (t.isThisExpression(arg.callee.object) || t.isIdentifier(arg.callee.object, { name: "__self" }))
                && !arg.arguments.some((x) => t.isSpreadElement(x))) {
                rp.node.argument = t.yieldExpression(t.callExpression(t.identifier("D"), [arg.callee.object, t.stringLiteral(arg.callee.property.name), ...arg.arguments]));
            }
        } });
    let yields = 0;
    traverse(file, { YieldExpression(yp) { if (isResYield(yp.node) || isAsyncDynYield(yp.node))
            yields++; } });
    if (!yields && !SYNC_METHODS)
        return null; // no tier calls: not a compilation candidate, no report either
    traverse(file, { Super(sp) {
            throw new Error(`tierless: ${clsName}.${mName} uses super (line ${sp.node.loc?.start.line ?? "?"}) — super dispatch can't be carried by the frame yet; the method stays uncompiled`);
        } });
    traverse(file, { ThisExpression(tp) {
            let f = tp.getFunctionParent(); // arrows share the enclosing this
            while (f && f.isArrowFunctionExpression())
                f = f.getFunctionParent();
            if (f && f.node === fnNode)
                tp.replaceWith(t.identifier("__self"));
        } });
    traverse(file, { AwaitExpression(ap) {
            if (ap.getFunctionParent()?.node !== fnNode)
                return; // a nested closure's own await: plain JS, stays
            throw new Error(`tierless: ${clsName}.${mName} awaits a non-resource value (line ${ap.node.loc?.start.line ?? "?"}) — a pending native promise can't migrate; the method stays uncompiled`);
        } });
    let path = null;
    traverse(file, { FunctionDeclaration(p) { if (p.node.id?.name === progName) {
            path = p;
            p.stop();
        } } });
    return lower(path);
}
function compile(src, preamble) {
    // jsx: a component module arrives with its JSX preserved (vite.mts) — it passes through
    // the kept code untouched; a compiled unit may not contain any (lowerCapsUnit)
    const ast = parser.parse(src, { sourceType: "module", plugins: ["jsx"] });
    allowlist(ast);
    checkNestedSuspensions(ast);
    USED_FORIN = false;
    USED_OBJREST = false;
    fnSites = {};
    fnSlots = {};
    const { fnPaths, rest, susp } = collectProgram(ast);
    suspSet = susp;
    MODULE_FNS = new Set();
    for (const st of ast.program.body) {
        const d = t.isExportNamedDeclaration(st) ? st.declaration : st;
        if (t.isFunctionDeclaration(d) && d.id)
            MODULE_FNS.add(d.id.name);
        else if (t.isVariableDeclaration(d))
            for (const dc of d.declarations)
                if (t.isIdentifier(dc.id) && t.isFunction(dc.init))
                    MODULE_FNS.add(dc.id.name);
    }
    const pure = [], progs = [], meta = { programs: [], exported: [], pure: [], imports: relativeImports(rest), methods: [] };
    // component/hook closures (opt-in) BEFORE the pure print below: a component is a pure
    // top-level function, printed from its node, so the stub swap must land first
    if (CLOSURES)
        compileComponentFunctions(ast, progs, meta, suspSet);
    for (const [name, { p, exported }] of fnPaths) { // pure single-tier fns run wholesale (lower() handles suspendable ones)
        if (suspSet.has(name)) {
            progs.push(lower(p));
            meta.programs.push(name);
            if (exported)
                meta.exported.push(name);
        }
        else {
            if (TRACK_WRITES)
                insertDirtyBarriers(p);
            pure.push((exported ? "export " : "") + gen(p.node));
            meta.pure.push(name);
        } // a pure helper can still mutate continuation state
    }
    if (SYNC_CLOSURES) {
        boxCapturedWrites(ast);
        rewriteBinds(ast, rest);
        convertClosures(ast, progs, meta);
    } // before: programs are lowered from the rewritten bodies, stubs included
    compileClassMethods(ast, progs, meta, rest); // class methods with tier calls (their nodes sit in `rest` — the stub swap lands in `kept`)
    if (SYNC_CLOSURES)
        convertSyncClosures(ast, progs, meta, rest); // after: it keeps a compiled class's bare identity
    compileStoreFunctions(ast, progs, meta); // setup-store functions (defineStore closures) — stub swaps mutate nodes already in `rest`
    const head = preamble + (TRACK_WRITES ? "\n" + TRACK_PREAMBLE : "");
    const kept = rest.length ? rest.map(gen).join("\n") + "\n" : ""; // imports / top-level state the module declared
    // for-of/for-in and object-rest emit a tiny pure helper — but ONLY when a source actually uses
    // the construct, so a bundle that doesn't is byte-for-byte unchanged.
    const helpers = (USED_FORIN ? FORIN_HELPER + "\n" : "") + (USED_OBJREST ? OBJREST_HELPER + "\n" : "");
    // --source-map: a pc->line table per program + a frameSite helper, so a migrated frame reports a
    // portable file:line. Gated, so without the flag the bundle is byte-for-byte what it was before.
    const sm = SOURCE_MAP ? `\nexport const SOURCE_FILE = ${JSON.stringify(srcFile)};\nexport const SITES = ${JSON.stringify(fnSites)};\nexport const frameSite = (f) => { const m = SITES[f.fn], ln = m && m[f.pc]; return SOURCE_FILE + ":" + (ln || "?"); };\nexport const stackSites = (stack) => stack.map(frameSite);\n` : "";
    // __slots: the §5 stop-rule table the pump consults before stepping a frame (only states
    // that reference any slot appear; programs with no entries are omitted entirely).
    const slotTable = Object.fromEntries(Object.entries(fnSlots).filter(([, t]) => Object.keys(t).length));
    const slotsOut = Object.keys(slotTable).length ? `export const __slots = ${JSON.stringify(slotTable)};\n` : "";
    const body = head + "\n" + kept + helpers + (pure.length ? pure.join("\n") + "\n" : "") + "export const PROGRAMS = {\n" + progs.join(",\n") + "\n};\n" + slotsOut + DRIVER + sm;
    // BUNDLE_HASH: identity of this exact compiled machine, for trace/profile validity (§6 of the
    // trajectory design: a site key is (fn, pc) and pcs silently change meaning across edits, so a
    // profile is only valid against the bundle whose traces built it). Hashed over the emitted code,
    // which is identical on both tiers.
    const hash = fnv1a(body);
    const code = body + `export const BUNDLE_HASH = ${JSON.stringify(hash)};\n`;
    // Machine-only server module (meta.serverCode): what a gateway needs to RESUME a
    // migrated method — programs, slots, driver, the module's own helper functions, and
    // only the imports that machine text references. The classes (and their constructor
    // graph: http factories, framework glue, window-touching modules) never load in Node;
    // the stop rule guarantees segments touching the live instance run at home, so the
    // machine never misses them. Same BUNDLE_HASH: it names the MACHINE, which is shared.
    if (meta.methods.some((m) => m.program)) {
        // Module helper functions ride ONLY if machine text (transitively) references them:
        // an app file's unrelated helpers routinely touch browser graphs (services, vue,
        // routers) that must never load in Node. Fixpoint over the pure list; imports then
        // filter against exactly what ships. The reference test requires the name NOT be
        // preceded by '.' or a word char: `__caps.router` is a property walk through the
        // caps handle, not a use of the router import.
        // not preceded by . (property walk), a word char, or a quote (a dyn park's member
        // STRING names the callee — it is data, not a binding reference)
        // ...and a whole identifier: `Section$loader` (a component closure's program name)
        // is not a use of `Section`, and \b would say it is — `$` is an identifier char
        const refdIn = (name, text) => new RegExp(`(?<![.\\w$"'])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).test(text);
        let machineText = progs.join(",\n");
        const included = new Set();
        // referenced TOP-LEVEL BINDINGS (const config values, arrow helpers) join the closure
        // like pure fns — the machine text names them, and without their declarations esbuild
        // treats them as globals and the migrated method dies at runtime. Classes stay
        // excluded by design (the machine reaches instances through frames, never constructs).
        const restDecls = rest
            .map((n) => (t.isExportNamedDeclaration(n) && n.declaration && t.isVariableDeclaration(n.declaration) ? n.declaration : n))
            .filter((n) => t.isVariableDeclaration(n));
        const declNames = restDecls.map((n) => n.declarations.map((d) => (t.isIdentifier(d.id) ? d.id.name : null)).filter((x) => !!x));
        const declIncluded = new Set();
        for (let changed = true; changed;) {
            changed = false;
            meta.pure.forEach((name, i) => {
                if (!included.has(i) && refdIn(name, machineText)) {
                    included.add(i);
                    machineText += "\n" + pure[i];
                    changed = true;
                }
            });
            declNames.forEach((names, i) => {
                if (!declIncluded.has(i) && names.some((nm) => refdIn(nm, machineText))) {
                    declIncluded.add(i);
                    machineText += "\n" + gen(restDecls[i]);
                    changed = true;
                }
            });
        }
        const keptPure = [...included].sort((a, b) => a - b).map((i) => pure[i]);
        const keptDecls = [...declIncluded].sort((a, b) => a - b).map((i) => gen(restDecls[i])); // original order: decls may reference each other
        const refd = (name) => refdIn(name, machineText);
        const keptImports = rest
            .filter((n) => t.isImportDeclaration(n))
            // side-effect-only imports (no specifiers — polyfills, global registrations) are
            // KEPT: the browser machine runs them; dropping them would make the tiers diverge.
            // A non-Node-safe one fails the emit-time bundling loudly instead.
            .filter((n) => n.specifiers.length === 0 || n.specifiers.some((s) => refd(s.local.name)))
            .map((n) => gen(n));
        meta.serverCode = [
            ...keptImports,
            helpers.trimEnd(),
            ...keptDecls,
            ...keptPure,
            "export const PROGRAMS = {\n" + progs.join(",\n") + "\n};",
            slotsOut.trimEnd(),
            DRIVER,
            `export const BUNDLE_HASH = ${JSON.stringify(hash)};`,
        ].filter(Boolean).join("\n") + "\n";
    }
    return { code, meta };
}
function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}
// ---- the module API (require("./transform.cjs")) — what the Vite plugin and CLI use ----
function configure(opts = {}) {
    AUTO_WRITEBACK = !!opts.autoWriteback;
    AUTO_DEREF = !!opts.autoDeref || AUTO_WRITEBACK; // a write through a handle must first materialize it
    TRACK_WRITES = !!opts.trackWrites;
    SOURCE_MAP = !!opts.sourceMap;
    CLOSURES = !!opts.closures;
    SYNC_CLOSURES = !!opts.syncClosures;
    MODULE_CODE = opts.moduleCode === undefined ? true : opts.moduleCode;
    SYNC_CALLS = !!opts.syncCalls;
    SYNC_METHODS = !!opts.syncMethods;
    cbCounter = 0; // generated names restart per compile: the same source compiles to the same bytes
    srcFile = opts.filename || "<tierless>";
    TIER_OF = { ...DEFAULT_RESOURCES, ...(opts.resources || {}) };
}
// compileModule(src, opts) -> { code, meta } where meta lists the compiled program names,
// which of them the source `export`ed (the actions surface), and the pure passthroughs.
function compileModule(src, opts = {}) {
    configure(opts);
    return compile(stripIfTs(src, opts.filename), opts.preamble || "");
}
// analyze(src, opts) -> per-function suspendability report (what `tierless explain` prints):
// is it compiled, why (direct resource touches / transitive calls), and every suspension point.
function analyze(src, opts = {}) {
    configure(opts);
    const ast = parser.parse(stripIfTs(src, opts.filename), { sourceType: "module" });
    allowlist(ast);
    checkNestedSuspensions(ast); // `explain` must reject exactly what `build` rejects — a tier call in a callback is un-compilable, not a compilable machine
    const { fnPaths, susp, directly, calls } = collectProgram(ast);
    const functions = [];
    for (const [name, { p, exported }] of fnPaths) {
        const suspensions = [];
        p.traverse({ YieldExpression(y) {
                if (!isResYield(y.node))
                    return;
                const a = y.node.argument.arguments;
                suspensions.push({ name: a[1].value, tier: a[0].value, line: y.node.loc ? y.node.loc.start.line : null });
            } });
        const via = [...calls.get(name)].filter((c) => susp.has(c));
        functions.push({ name, exported, suspendable: susp.has(name), direct: directly.has(name), suspensions, callsSuspendable: via });
    }
    return { functions, resources: { ...TIER_OF } };
}
const DRIVER = `
// A §5 handle — a big local that stayed on its owning tier (see ../heap.mjs). With
// --auto-deref the machine guards reads of remotable locals with this check.
export const isHandle = (x) => x !== null && typeof x === "object" && x.__tierless_handle__ === true;
// Exception dispatch over the serializable handler stack F.__h. Returns the pc of the
// catch/finally to enter, or null if the throw escapes this frame. Called from the
// machine (for \`throw\`) and from the runtime (when a migrated resource throws).
export function __dispatch(F, err) {
  const hs = F.__h;
  while (hs && hs.length) {
    const h = hs[hs.length - 1];
    if (h.catch != null && h.state === 0) { h.state = 1; F.__err = err; return h.catch; }  // enter catch (handler stays for a wrapping finally)
    if (h.fin != null && h.state < 2) { h.state = 2; F.__c = { type: "throw", arg: err }; return h.fin; }
    hs.pop();
  }
  return null;
}
// Drive a pending return/break/continue (F.__c) through the finallys it must still run:
// pop the handlers of crossed try/catch regions, then return the next finally pc (or null
// when none remain and the completion should execute).
export function __unwindStep(F) {
  const c = F.__c; if (!c || !c.steps) return null;
  while (c.steps.length && c.steps[0].pop !== undefined) { for (let i = 0; i < c.steps[0].pop; i++) F.__h.pop(); c.steps.shift(); }
  if (c.steps.length) return c.steps.shift().fin;
  return null;
}
// Unwind an error across FRAMES: try the top frame's handlers, else pop it and try the
// caller. A resource that fails in a callee is thus caught by a try/catch in a caller.
export function __unwind(stack, err) {
  while (stack.length) { const tpc = __dispatch(stack[stack.length - 1], err); if (tpc != null) { stack[stack.length - 1].pc = tpc; return true; } stack.pop(); }
  return false;
}
// Real-code seam: compiled class-method stubs route through this binding when a page or
// runtime set it (a function (program, thisArg, args) -> Promise); unbound, every stub
// falls back to the kept original method — the bundle behaves stock.
export let __TIERLESS_METHOD__ = null;
export function __bindTierlessMethods(fn) { __TIERLESS_METHOD__ = fn; }
// Single-tier driver: step the machine, push sub-frames for calls, stop at every resource
// request. The two-tier runtime (../runtime.mjs) drives PROGRAMS directly and only stops
// at resources THIS tier doesn't own; this local driver keeps the bundle runnable alone.
export function run(stack) {
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (r.op === "throw") { stack.pop(); if (!__unwind(stack, r.value)) throw r.value; }
    else if (r.op === "resource") return { done: false, request: r, stack };
  }
}
export const start = (fn, args = []) => run([{ fn, pc: 0, args }]);
`;
// ---- CLI ----
function cliMain() {
    const args = process.argv.slice(2);
    const flags = args.filter((a) => a.startsWith("--"));
    const [inPath, outPath] = args.filter((a) => !a.startsWith("--"));
    if (!inPath || !outPath) {
        console.error("usage: node transform.cjs <in.js> <out.gen.mjs> [--bare] [--head=<file>] [--auto-deref] [--auto-writeback] [--track-writes] [--source-map] [--resource=ns:tier ...]");
        process.exit(2);
    }
    const resources = {}; // --resource=db:server adds to the defaults
    for (const f of flags)
        if (f.startsWith("--resource=")) {
            const [ns, tier] = f.slice("--resource=".length).split(":");
            if (!ns || !tier) {
                console.error("bad --resource (want ns:tier): " + f);
                process.exit(2);
            }
            resources[ns] = tier;
        }
    // The pure helpers an app's suspendable functions call (h/render/components) live in their own
    // modules; the generated bundle imports them. --head=<file> supplies those import lines for a given
    // app (so a second app can name its own components); the default is the Tasks app's.
    const headFlag = flags.find((f) => f.startsWith("--head="));
    const preamble = flags.includes("--bare") ? ""
        : headFlag ? fs.readFileSync(headFlag.slice("--head=".length), "utf8").trimEnd()
            : 'import { h } from "./h.mjs";\nimport { Dashboard } from "./components.mjs";\nimport { render } from "./render.mjs";';
    try {
        const { code } = compileModule(fs.readFileSync(inPath, "utf8"), {
            preamble, resources, filename: inPath,
            autoWriteback: flags.includes("--auto-writeback"),
            autoDeref: flags.includes("--auto-deref"),
            trackWrites: flags.includes("--track-writes"),
            sourceMap: flags.includes("--source-map"),
        });
        fs.writeFileSync(outPath, "// GENERATED by transform.cjs from " + inPath + " — do not edit by hand.\n" + code);
        console.log("wrote " + outPath);
    }
    catch (e) {
        console.error(e.message);
        process.exit(2);
    } // un-compilable input (e.g. a tier call in a callback) — print the clear message, not a V8 stack
}
if (require.main === module)
    cliMain();
module.exports = { compile: compileModule, analyze, DEFAULT_RESOURCES };
