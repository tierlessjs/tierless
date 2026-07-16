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
import parser = require("@babel/parser");
import traverseModule = require("@babel/traverse");
import type { NodePath } from "@babel/traverse";
import generatorModule = require("@babel/generator");
import t = require("@babel/types");
import fs = require("fs");
import nodeModule = require("node:module");
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
function stripIfTs(src: string, filename: string | undefined): string {
  return filename && TS_FILE.test(filename) ? stripTypeScriptTypes(src, { mode: "strip" }) : src;
}
const gen = (n: t.Node): string => generate(n, { concise: true }).code;

// ---- shared IR types: the block/terminator graph compileStmt builds, and the context
// threaded through it (break/continue/return targets, the enclosing try stack, labels). ----
type AbruptStep = { pop: number } | { finRaw: number };
type Term =
  | { kind: "jump"; to: number }
  | { kind: "susp"; op: string; resume: number }
  | { kind: "call"; fn: string; args: string; resume: number }
  | { kind: "branch"; cond: string; then: number; else: number }
  | { kind: "ret"; value: string }
  | { kind: "throw"; value: string }
  | { kind: "pushTry"; catch: number | null; fin: number | null; to: number }
  | { kind: "finish"; after: number }
  // ctype discriminates which of value/targetRaw is meaningful (return -> value, break/continue
  // -> targetRaw); both are declared optional rather than a strict per-ctype union because
  // abruptExit constructs this from an already-narrowed Completion and copies both fields over
  // unconditionally (see Completion below) — the irrelevant one is simply absent at runtime.
  | { kind: "abrupt"; ctype: "return" | "break" | "continue"; value?: string; targetRaw?: number | null; steps: AbruptStep[] };
interface Block { lines: string[]; term: Term | null; line?: number }
// A pending return/break/continue crossing enclosing trys (F.__c on the frame). Same
// value/targetRaw looseness as Term's abrupt case, for the same reason.
type Completion = { ctype: "return"; value: string } | { ctype: "break" | "continue"; targetRaw: number };

interface TryFrame { hasFinally: boolean; finB?: number }
interface LabelTarget { brk: number | null | undefined; brkDepth: number | undefined; cont: number | null | undefined; contDepth: number | undefined }
// Threaded through compileStmt/compileStmts: where break/continue/return currently jump to,
// the enclosing try stack (so an abrupt exit pops the right handlers / runs crossed finallys),
// and the in-scope labels. Spread-and-overridden at nearly every call site (loops rebind
// brk/cont, try bumps tryDepth, switch rebinds brk only, …), so most fields are optional here
// rather than trying to encode exactly which combination is guaranteed present where.
interface Ctx {
  next: number;
  brk?: number | null; brkDepth?: number;
  cont?: number | null; contDepth?: number;
  tryDepth: number;
  tryStack: TryFrame[];
  labels: Record<string, LabelTarget>;
  label?: string;
}

// ---- PASS 1: allow-list rewrite. Calls to tier-pinned namespaces become yields. ----
// The allow-list: which call namespaces are tier-pinned. `api.*` -> server and `commit()` ->
// browser are the defaults; a deployment adds its own via opts.resources / --resource=ns:tier
// (a member namespace like `db.*`, or a bare call like `commit` which compiles as "dom.<name>").
const DEFAULT_RESOURCES: Record<string, string> = { api: "server", commit: "browser" };
let TIER_OF: Record<string, string> = { ...DEFAULT_RESOURCES };
function allowlist(ast: t.File): void {
  traverse(ast, { CallExpression(p) {
    // class bodies are handled per-method by compileClassMethods (which re-runs this pass
    // on the isolated method); an uncompiled method must keep its RAW calls, not yields
    if (p.findParent((q) => q.isClassBody())) return;
    const c = p.node.callee;
    let tier: string | null = null, name: string | null = null;
    const args = p.node.arguments;
    if (t.isMemberExpression(c) && t.isIdentifier(c.object) && TIER_OF[c.object.name] && t.isIdentifier(c.property)) {
      tier = TIER_OF[c.object.name]; name = c.object.name + "." + c.property.name;     // api.getTasks(...)
    } else if (t.isMemberExpression(c) && t.isMemberExpression(c.object) && t.isIdentifier(c.property)
      && (t.isThisExpression(c.object.object) || (t.isIdentifier(c.object.object) && c.object.object.name === "__self"))
      && t.isIdentifier(c.object.property) && TIER_OF["this." + c.object.property.name]) {
      // this.http.get(...) — an instance-held resource (config key "this.http"). The
      // receiver is dropped from the request: the namespace is bound per tier by the
      // exec, not carried as data (the instance itself never crosses for the call).
      tier = TIER_OF["this." + c.object.property.name]; name = c.object.property.name + "." + c.property.name;
    } else if (t.isIdentifier(c) && TIER_OF[c.name]) {
      tier = TIER_OF[c.name]; name = "dom." + c.name;                                   // commit(...)
    } else if (t.isIdentifier(c) && c.name === "deref") {
      tier = "@deref"; name = "deref";                                                  // deref(handle): fetch from the handle's owner
    }
    if (!tier || name == null) return;                             // (tier and name are always set together — this just proves it to tsc)
    const y = t.yieldExpression(t.callExpression(t.identifier("R"),
      [t.stringLiteral(tier), t.stringLiteral(name), ...args]));
    y.loc = p.node.loc;                                            // keep the call site for analyze()/--source-map reporting
    // real code writes `await this.http.get(...)` — the await IS the suspension, absorb it
    if (p.parentPath.isAwaitExpression()) p.parentPath.replaceWith(y); else p.replaceWith(y);
    // no p.skip(): keep traversing so nested tier calls in the args (e.g. api.f(api.g())) get rewritten too
  } });
}

// ---- PASS 2: state machine. Compile a suspendable function's body into basic blocks.
// ctx threads the targets break/continue/return jump to (brk/cont per loop, labels for
// labeled loops) plus tryStack — the enclosing trys — so an abrupt exit pops the right
// handlers and refuses to silently skip a finally.
let blocks: Block[], suspSet: Set<string>, AUTO_DEREF = false, AUTO_WRITEBACK = false, TRACK_WRITES = false;
let SOURCE_MAP = false, curLine = 0, srcFile = "", fnSites: Record<string, Record<number, number | undefined>> = {};   // --source-map: stamp each block with its source line so a migrated frame reports file:line, not just a pc
let fnSlots: Record<string, Record<number, string[]>> = {};   // §5 stop rule: per program per state, the frame slots its segment references (docs/migrate-arm.md)
const nb = (): number => { const b: Block = { lines: [], term: null }; if (SOURCE_MAP) b.line = curLine; blocks.push(b); return blocks.length - 1; };
const isSusp = (s: t.Statement): boolean =>
  (t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isYieldExpression(s.declarations[0].init)) ||
  (t.isExpressionStatement(s) && t.isYieldExpression(s.expression));
// Only ever called on a statement isSusp() already verified (a VariableDeclaration whose sole
// init is a yield, or an ExpressionStatement wrapping one) — the shape isn't visible to tsc
// across that caller/callee boundary, so it's asserted here rather than re-checked.
function suspInfo(s: t.Statement): { assign: string | null; op: string } {
  const y = (t.isVariableDeclaration(s) ? s.declarations[0].init : (s as t.ExpressionStatement).expression) as t.YieldExpression;
  const assign = t.isVariableDeclaration(s) ? (s.declarations[0].id as t.Identifier).name : null;
  const call = y.argument as t.CallExpression;
  const a = call.arguments as t.Node[];
  if ((call.callee as t.Identifier).name === "D") {
    // D(recv, "member", ...args) — the DYNAMIC call park (docs/migrate-arm.md slice 3).
    // The machine only DESCRIBES the call; the pump dispatches it (twin instance on a
    // class-stamped handle / nested machine on a stamped stub / promise settled in
    // place), because only the pump holds PROGRAMS, isHandle, and the twin registry.
    return { assign, op: `{ op: "dyn", recv: ${gen(a[0])}, member: ${gen(a[1])}, args: [${a.slice(2).map(gen).join(", ")}] }` };
  }
  return { assign, op: `{ op: "resource", tier: ${gen(a[0])}, name: ${gen(a[1])}, args: [${a.slice(2).map(gen).join(", ")}] }` };   // R(tier, name, ...args)
}
// a statement that calls another suspendable (compiled) function -> push a sub-frame
function callSusp(s: t.Statement): { assign: string | null; fn: string; args: string } | null {
  let call: t.CallExpression | null = null, assign: string | null = null;
  if (t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isCallExpression(s.declarations[0].init)) { call = s.declarations[0].init; assign = (s.declarations[0].id as t.Identifier).name; }
  else if (t.isExpressionStatement(s) && t.isCallExpression(s.expression)) call = s.expression;
  if (call && t.isIdentifier(call.callee) && suspSet.has(call.callee.name)) return { assign, fn: call.callee.name, args: call.arguments.map((a) => gen(a as t.Node)).join(", ") };
  return null;
}
// A generic AST walk over ANY node shape (not just the cases callers narrow to), so its inner
// walker is intentionally untyped — see the module comment above containsSuspCall's uses.
// Walk each child value of a raw AST node, skipping Babel's position/comment metadata (which the two
// untyped walkers below must not descend into). One copy of the skip-list, so it can't drift.
const AST_META = new Set(["loc", "start", "end", "leadingComments", "trailingComments"]);
function eachChild(n: any, fn: (child: any) => void): void { for (const k in n) if (!AST_META.has(k)) fn(n[k]); }

function containsSuspCall(node: t.Node | t.Node[] | null | undefined): boolean {   // a suspendable call buried in a sub-expression (rejected)
  let found = false;
  (function walk(n: any) {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "CallExpression" && n.callee && n.callee.type === "Identifier" && suspSet.has(n.callee.name)) { found = true; return; }
    eachChild(n, walk);
  })(node);
  return found;
}

// ---- ANF normalization: hoist suspensions out of expression positions ----
// A suspension is a tier resource yield (R(...)) or a call to a suspendable function.
// After this pass every suspension is `const __tN = <susp>;` or `<susp>;` — a statement,
// which is all compileStmt knows how to lower. This is what lets ordinary code compile:
// `return f(x)`, `out = api.get()`, `a + f(x)`, `g(f(x))`, `if (api.check())`, `while (...)`.
const isResYield = (n: t.Node | null | undefined): n is t.YieldExpression => !!n && t.isYieldExpression(n) && t.isCallExpression(n.argument) && t.isIdentifier(n.argument.callee, { name: "R" });
const isDynYield = (n: t.Node | null | undefined): n is t.YieldExpression => !!n && t.isYieldExpression(n) && t.isCallExpression(n.argument) && t.isIdentifier(n.argument.callee, { name: "D" });   // the dynamic call park (slice 3)
const isSuspCallNode = (n: t.Node | null | undefined): n is t.CallExpression => !!n && t.isCallExpression(n) && t.isIdentifier(n.callee) && suspSet.has(n.callee.name);
const isSuspExpr = (n: t.Node | null | undefined): n is t.YieldExpression | t.CallExpression => isResYield(n) || isDynYield(n) || isSuspCallNode(n);
// Same "generic walk, untyped inner walker" shape as containsSuspCall.
function hasSuspInside(node: t.Node | t.Node[] | null | undefined, exclSelf: boolean): boolean {
  let found = false;
  (function walk(n: any, root: boolean) {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x: any) => walk(x, false));
    if (!(root && exclSelf) && isSuspExpr(n)) { found = true; return; }
    eachChild(n, (c) => walk(c, false));
  })(node, true);
  return found;
}
const isHeadNormal = (path: NodePath): boolean => {                // already in a position compileStmt handles
  const p = path.parentPath;
  if (!p) return false;
  if (p.isExpressionStatement()) return true;
  if (p.isVariableDeclarator() && p.node.init === path.node) { const d = p.parentPath; return !!d && (d.node as t.VariableDeclaration).declarations.length === 1 && (d.parentPath?.isBlockStatement() || d.parentPath?.isProgram() || d.parentPath?.isSwitchCase()); }
  return false;
};
function assertSafeContext(path: NodePath, stmt: NodePath): void {  // safety net: nothing should reach here in a conditional position after desugaring
  let cur: NodePath | null = path;
  while (cur && cur !== stmt) {
    const par: NodePath | null = cur.parentPath;
    if (!par) break;
    if (par.isLogicalExpression() && par.node.right === cur.node) throw new Error("suspension in the right side of && / || / ?? is not supported");
    if (par.isConditionalExpression() && (par.node.consequent === cur.node || par.node.alternate === cur.node)) throw new Error("suspension in a branch of ?: is not supported");
    // optional chaining: the base (object/callee) is unconditional and may be hoisted; only the
    // conditional part — a computed access ?.[susp] or optional-call args ?.(susp) — is rejected.
    if (par.isOptionalMemberExpression() && par.node.optional && par.node.property === cur.node) throw new Error("suspension in an optional computed access (?.[ ]) is not supported (lift it to a statement)");
    if (par.isOptionalCallExpression() && par.node.optional && par.node.arguments.indexOf(cur.node as t.Expression | t.SpreadElement | t.ArgumentPlaceholder) >= 0) throw new Error("suspension in optional-call arguments (?.()) is not supported (lift it to a statement)");
    cur = par;
  }
}
// && || ?? ?: that CONTAIN a suspension -> lift into a temp via if-statements, so only the
// taken branch's suspension evaluates. The branches/test then normalize like any statement.
function desugarCondLog(path: NodePath, name: string): void {
  const n = path.node as t.ConditionalExpression | t.LogicalExpression;
  const id = () => t.identifier(name), assign = (v: t.Expression) => t.expressionStatement(t.assignmentExpression("=", id(), v));
  const out: t.Statement[] = [];
  if (t.isConditionalExpression(n)) {
    out.push(t.variableDeclaration("let", [t.variableDeclarator(id())]));
    out.push(t.ifStatement(n.test, t.blockStatement([assign(n.consequent)]), t.blockStatement([assign(n.alternate)])));
  } else {                                                          // LogicalExpression
    out.push(t.variableDeclaration("let", [t.variableDeclarator(id(), n.left)]));
    const cond = n.operator === "&&" ? id() : n.operator === "||" ? t.unaryExpression("!", id()) : t.binaryExpression("==", id(), t.nullLiteral());
    out.push(t.ifStatement(cond, t.blockStatement([assign(n.right)])));
  }
  path.getStatementParent()!.insertBefore(out);
  path.replaceWith(id());
}
// obj?.[api.x()] / obj?.(api.x()) / obj.m?.(api.x()) — a suspension in an optional chain's
// CONDITIONAL region must evaluate ONLY when the chain hasn't short-circuited. Peel the chain's
// deepest `?.` into an explicit `== null` guard + temp (Babel's optional-chaining lowering, but
// emitted as statements so the suspension hoists into the non-short-circuit branch). `this` is
// preserved: `obj?.m(x)` de-optionalizes only the member, so `_o.m(x)` still binds this=_o; an
// optional call on a member `obj.m?.(x)` lowers to `_f.call(_o, x)`. Iterated to a fixpoint, so a
// multi-`?.` chain peels one guard per pass (deepest first, its base being suspension-free).
function outermostChain(p: NodePath): NodePath {                  // climb to the top node of p's member/call chain
  let E = p;
  for (;;) {
    const par = E.parentPath;
    if (par && (par.isMemberExpression() || par.isOptionalMemberExpression()) && par.node.object === E.node) E = par;
    else if (par && (par.isCallExpression() || par.isOptionalCallExpression()) && par.node.callee === E.node) E = par;
    else return E;
  }
}
function chainHasOptional(E: NodePath): boolean {                  // a real `?.` (optional=true) still present in the spine?
  for (let cur: NodePath | null = E; cur;) {
    if ((cur.isOptionalMemberExpression() || cur.isOptionalCallExpression()) && cur.node.optional) return true;
    if (cur.isMemberExpression() || cur.isOptionalMemberExpression()) cur = cur.get("object") as NodePath;
    else if (cur.isCallExpression() || cur.isOptionalCallExpression()) cur = cur.get("callee") as NodePath;
    else return false;
  }
  return false;
}
function desugarOptionalChain(E: NodePath, name: string, fresh: () => string): void {
  const cst = (nm: string, init: t.Expression) => t.variableDeclaration("const", [t.variableDeclarator(t.identifier(nm), init)]);
  const setR = (v: t.Expression) => t.expressionStatement(t.assignmentExpression("=", t.identifier(name), v));
  let P: NodePath<t.OptionalMemberExpression | t.OptionalCallExpression> | null = null;
  let cur: NodePath | null = E;                                    // deepest optional along the object/callee spine
  for (;;) {
    if (cur && (cur.isOptionalMemberExpression() || cur.isOptionalCallExpression()) && cur.node.optional) P = cur;
    if (cur && (cur.isMemberExpression() || cur.isOptionalMemberExpression())) cur = cur.get("object") as NodePath;
    else if (cur && (cur.isCallExpression() || cur.isOptionalCallExpression())) cur = cur.get("callee") as NodePath;
    else break;
  }
  if (!P) throw new Error("tierless: desugarOptionalChain found no optional member/call in the chain");
  const out: t.Statement[] = [t.variableDeclaration("let", [t.variableDeclarator(t.identifier(name))])];
  let guard: string;
  if (P.isOptionalCallExpression() && ((P.get("callee") as NodePath).isMemberExpression() || (P.get("callee") as NodePath).isOptionalMemberExpression())) {
    const callee = (P.node as t.OptionalCallExpression).callee as t.MemberExpression | t.OptionalMemberExpression, o = fresh(), f = fresh();       // obj.m?.(args) -> _o=obj; _f=_o.m; _f.call(_o, args)  (this=_o)
    out.push(cst(o, callee.object as t.Expression), cst(f, t.memberExpression(t.identifier(o), callee.property, callee.computed)));
    P.replaceWith(t.callExpression(t.memberExpression(t.identifier(f), t.identifier("call")), [t.identifier(o), ...(P.node as t.OptionalCallExpression).arguments]));
    guard = f;
  } else if (P.isOptionalCallExpression()) {
    const f = fresh();                                            // f?.(args) -> _f=f; _f(args)  (this=undefined)
    out.push(cst(f, P.node.callee as t.Expression));
    P.replaceWith(t.callExpression(t.identifier(f), P.node.arguments));
    guard = f;
  } else {
    const o = fresh();                                            // obj?.prop / obj?.[key] -> _o=obj; _o.prop / _o[key]
    const mem = P.node as t.OptionalMemberExpression;
    out.push(cst(o, mem.object as t.Expression));
    P.replaceWith(t.memberExpression(t.identifier(o), mem.property, mem.computed));   // real member: no residual optional=true
    guard = o;
  }
  out.push(t.ifStatement(t.binaryExpression("==", t.identifier(guard), t.nullLiteral()),
    t.blockStatement([setR(t.identifier("undefined"))]), t.blockStatement([setR(E.node as t.Expression)])));
  E.getStatementParent()!.insertBefore(out);
  E.replaceWith(t.identifier(name));
}
function normalize(fnPath: NodePath<t.FunctionDeclaration>): void {
  let counter = 0;
  const fresh = () => "__t" + (counter++);
  // Wrap any non-block if-branch or loop body whose suspension will be HOISTED, so the hoisted
  // `const __t = <susp>` lands INSIDE the conditionally-executed branch — not before the if/loop,
  // where it would run unconditionally (e.g. `if (c) x = f();` must only call f when c). Else-if
  // chains (an IfStatement alternate) are left intact, and a BARE suspension statement (`else
  // api.f();` — already head-normal, no hoist) is left untouched, so Tasks-style code is unchanged.
  const willHoist = (n: t.Node | null | undefined): boolean => !!n && !t.isBlockStatement(n) && !t.isIfStatement(n) && hasSuspInside(n, false) && !(t.isExpressionStatement(n) && isSuspExpr(n.expression));
  // key names a body/consequent/alternate slot across If/For/While/DoWhile/ForOf/ForIn — a
  // different concrete shape per caller, so accessed dynamically rather than per-node-type.
  const wrapSusp = (p: NodePath, key: string): void => { if (willHoist((p.node as any)[key])) (p.get(key) as NodePath).replaceWith(t.blockStatement([(p.node as any)[key]])); };
  fnPath.traverse({
    IfStatement(p) { wrapSusp(p, "consequent"); wrapSusp(p, "alternate"); },
    ForStatement(p) { wrapSusp(p, "body"); }, WhileStatement(p) { wrapSusp(p, "body"); }, DoWhileStatement(p) { wrapSusp(p, "body"); },
    ForOfStatement(p) { wrapSusp(p, "body"); }, ForInStatement(p) { wrapSusp(p, "body"); },
  });
  for (let guard = 0; guard < 100000; guard++) {
    let acted = false;
    fnPath.traverse({ WhileStatement(p) {                         // while(E) where E suspends -> while(true){ if(!(E)) break; body }
      if (acted || t.isBooleanLiteral(p.node.test, { value: true }) || !hasSuspInside(p.node.test, false)) return;
      const body = t.isBlockStatement(p.node.body) ? p.node.body.body : [p.node.body];
      p.replaceWith(t.whileStatement(t.booleanLiteral(true), t.blockStatement([t.ifStatement(t.unaryExpression("!", p.node.test), t.blockStatement([t.breakStatement()])), ...body])));
      acted = true; p.stop();
    } });
    if (acted) continue;
    fnPath.traverse({ ForStatement(p) {                           // for with a suspending test/update -> while with the update at the top of each pass
      if (acted) return;
      const node = p.node;
      if ((node.test && hasSuspInside(node.test, false)) || (node.update && hasSuspInside(node.update, false))) {
        // for(init;test;update) BODY -> { init; let __f=true; while(true){ if(__f)__f=false; else update; if(!test)break; BODY } }
        const fv = fresh();
        const body = t.isBlockStatement(node.body) ? node.body.body : [node.body];
        const wbody: t.Statement[] = [t.ifStatement(t.identifier(fv), t.expressionStatement(t.assignmentExpression("=", t.identifier(fv), t.booleanLiteral(false))), node.update ? t.expressionStatement(node.update) : null)];
        if (node.test) wbody.push(t.ifStatement(t.unaryExpression("!", node.test), t.blockStatement([t.breakStatement()])));
        wbody.push(...body);
        const outer: t.Statement[] = [];
        if (node.init) outer.push(t.isVariableDeclaration(node.init) ? node.init : t.expressionStatement(node.init));
        outer.push(t.variableDeclaration("let", [t.variableDeclarator(t.identifier(fv), t.booleanLiteral(true))]));
        outer.push(t.whileStatement(t.booleanLiteral(true), t.blockStatement(wbody)));
        p.replaceWith(t.blockStatement(outer)); acted = true; p.stop(); return;
      }
      if (node.init && hasSuspInside(node.init, false)) {          // init runs once -> a plain statement before the loop
        p.insertBefore(t.isVariableDeclaration(node.init) ? node.init : t.expressionStatement(node.init));
        node.init = null; acted = true; p.stop();
      }
    } });
    if (acted) continue;
    fnPath.traverse({ DoWhileStatement(p) {                        // do BODY while(test-suspends) -> { let __o=true; while(__o||test){ __o=false; BODY } }
      if (acted || !hasSuspInside(p.node.test, false)) return;
      const ov = fresh();
      const body = t.isBlockStatement(p.node.body) ? p.node.body.body : [p.node.body];
      p.replaceWith(t.blockStatement([
        t.variableDeclaration("let", [t.variableDeclarator(t.identifier(ov), t.booleanLiteral(true))]),
        t.whileStatement(t.logicalExpression("||", t.identifier(ov), p.node.test), t.blockStatement([t.expressionStatement(t.assignmentExpression("=", t.identifier(ov), t.booleanLiteral(false))), ...body])),
      ]));
      acted = true; p.stop();
    } });
    if (acted) continue;
    fnPath.traverse({ enter(p: NodePath) {                          // desugar an OUTERMOST && / || / ?? / ?: that contains a suspension
      if (acted) return;
      const n = p.node;
      if (!(t.isConditionalExpression(n) || t.isLogicalExpression(n)) || !hasSuspInside(n, false)) return;
      desugarCondLog(p, fresh());
      acted = true; p.stop();
    } });
    if (acted) continue;
    fnPath.traverse({ "OptionalMemberExpression|OptionalCallExpression"(p: NodePath) {   // peel an optional chain that guards a suspension
      if (acted) return;
      const E = outermostChain(p);
      if (!hasSuspInside(E.node, false) || !chainHasOptional(E)) return;       // only when a real `?.` guards a suspension
      desugarOptionalChain(E, fresh(), fresh);
      acted = true; p.stop();
    } });
    if (acted) continue;
    fnPath.traverse({ enter(p: NodePath) {                          // hoist one innermost, non-head-normal suspension into a temp
      if (acted) return;
      const n = p.node;
      if (!isSuspExpr(n) || hasSuspInside(n, true) || isHeadNormal(p)) return;
      const stmt = p.getStatementParent()!;    // always non-null: every expression here is inside some statement in the function body
      if (stmt.isForStatement() || stmt.isDoWhileStatement() || stmt.isForOfStatement() || stmt.isForInStatement()) throw new Error("suspension in this loop header is not supported (assign it inside the body)");
      assertSafeContext(p, stmt);
      const name = fresh();
      stmt.insertBefore(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(name), n)]));
      p.replaceWith(t.identifier(name));
      acted = true; p.stop();
    } });
    if (!acted) break;
  }
}
const blockStmts = (n: t.Statement): t.Statement[] => (t.isBlockStatement(n) ? n.body : [n]);
const withNext = (ctx: Ctx, next: number): Ctx => ({ ...ctx, next });
function compileStmts(stmts: t.Statement[], ctx: Ctx): number { let cont = ctx.next; for (let i = stmts.length - 1; i >= 0; i--) cont = compileStmt(stmts[i], withNext(ctx, cont)); return cont; }

// Register a loop/switch label so `break label` / `continue label` can find their targets.
const regLabel = (ctx: Ctx, brk: number | null | undefined, brkDepth: number | undefined, cont: number | null | undefined, contDepth: number | undefined): Record<string, LabelTarget> => (ctx.label ? { ...ctx.labels, [ctx.label]: { brk, brkDepth, cont, contDepth } } : ctx.labels);

function compileStmt(s: t.Statement, ctx: Ctx): number {
  if (SOURCE_MAP && s.loc) curLine = s.loc.start.line;            // blocks created while lowering this statement map back to its line
  const { next, tryDepth } = ctx;

  if (isSusp(s)) {                                                 // const x = api.f() -> suspend on a resource
    const { assign, op } = suspInfo(s);
    const r = nb(); if (assign) blocks[r].lines.push(`F.${assign} = F.ret;`); blocks[r].term = { kind: "jump", to: next };
    const b = nb(); blocks[b].term = { kind: "susp", op, resume: r }; return b;
  }
  const cs = callSusp(s);
  if (cs) {                                                        // const x = helper() -> push a sub-frame for helper
    const r = nb(); if (cs.assign) blocks[r].lines.push(`F.${cs.assign} = F.ret;`); blocks[r].term = { kind: "jump", to: next };
    const b = nb(); blocks[b].term = { kind: "call", fn: cs.fn, args: cs.args, resume: r }; return b;
  }
  if (t.isBlockStatement(s)) return compileStmts(s.body, ctx);
  if (t.isEmptyStatement(s)) { const b = nb(); blocks[b].term = { kind: "jump", to: next }; return b; }

  if (t.isLabeledStatement(s)) {                                   // label: loop/switch -> pass the label down for it to register
    if (t.isWhileStatement(s.body) || t.isForStatement(s.body) || t.isDoWhileStatement(s.body) || t.isSwitchStatement(s.body)) return compileStmt(s.body, { ...ctx, label: s.label.name });
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
    if (s.init) { if (t.isVariableDeclaration(s.init)) for (const d of s.init.declarations) { if (d.init) blocks[init].lines.push(`F.${(d.id as t.Identifier).name} = ${gen(d.init)};`); } else blocks[init].lines.push(`${gen(s.init)};`); }
    const head = nb(), update = nb(); if (s.update) blocks[update].lines.push(`${gen(s.update)};`);
    const labels = regLabel(ctx, next, tryDepth, update, tryDepth);
    const body = compileStmts(blockStmts(s.body), { ...ctx, next: update, brk: next, brkDepth: tryDepth, cont: update, contDepth: tryDepth, labels, label: undefined }); // continue -> update
    blocks[init].term = { kind: "jump", to: head };
    blocks[head].term = s.test ? { kind: "branch", cond: gen(s.test), then: body, else: next } : { kind: "jump", to: body };
    blocks[update].term = { kind: "jump", to: head };
    return init;
  }
  if (t.isDoWhileStatement(s)) {
    if (hasSuspInside(s.test, false)) throw new Error("suspension in a do-while test is not supported");
    const head = nb(), test = nb();
    const labels = regLabel(ctx, next, tryDepth, test, tryDepth);
    const body = compileStmts(blockStmts(s.body), { ...ctx, next: test, brk: next, brkDepth: tryDepth, cont: test, contDepth: tryDepth, labels, label: undefined });
    blocks[head].term = { kind: "jump", to: body };
    blocks[test].term = { kind: "branch", cond: gen(s.test), then: head, else: next };  // body runs first, then test loops back
    return head;
  }
  if (t.isSwitchStatement(s)) {
    if (s.cases.some((c) => c.test && containsSuspCall(c.test))) throw new Error("suspendable call in a case label is not supported");
    const disc = gen(s.discriminant), after = next;               // discriminant already hoisted by normalize if it suspended
    const labels = regLabel(ctx, after, tryDepth, ctx.cont, ctx.contDepth);  // break -> end of switch; continue -> the enclosing loop
    const swCtx = { ...ctx, brk: after, brkDepth: tryDepth, labels, label: undefined };
    const entries = new Array(s.cases.length);
    let fall = after;                                             // cases fall through to the next
    for (let i = s.cases.length - 1; i >= 0; i--) { entries[i] = compileStmts(s.cases[i].consequent, { ...swCtx, next: fall }); fall = entries[i]; }
    const defIdx = s.cases.findIndex((c) => c.test === null);
    let dispatch = defIdx >= 0 ? entries[defIdx] : after;         // no match -> default (or past the switch)
    for (let i = s.cases.length - 1; i >= 0; i--) { const test = s.cases[i].test; if (test == null) continue; const b = nb(); blocks[b].term = { kind: "branch", cond: `${disc} === ${gen(test)}`, then: entries[i], else: dispatch }; dispatch = b; }
    return dispatch;
  }
  if (t.isIfStatement(s)) {
    const consequent = compileStmts(blockStmts(s.consequent), ctx);
    const alt = s.alternate ? compileStmts(blockStmts(s.alternate), ctx) : next;
    const b = nb(); blocks[b].term = { kind: "branch", cond: gen(s.test), then: consequent, else: alt }; return b;
  }
  if (t.isBreakStatement(s)) {
    const tg = s.label ? ctx.labels[s.label.name] : { brk: ctx.brk, brkDepth: ctx.brkDepth };
    if (!tg || tg.brk == null) throw new Error("break has no target");
    return abruptExit(ctx, tg.brkDepth!, { ctype: "break", targetRaw: tg.brk });   // pop crossed handlers / run crossed finallys
  }
  if (t.isContinueStatement(s)) {
    const tg = s.label ? ctx.labels[s.label.name] : { cont: ctx.cont, contDepth: ctx.contDepth };
    if (!tg || tg.cont == null) throw new Error("continue has no target");
    return abruptExit(ctx, tg.contDepth!, { ctype: "continue", targetRaw: tg.cont });
  }
  if (t.isReturnStatement(s)) {
    return abruptExit(ctx, 0, { ctype: "return", value: s.argument ? gen(s.argument) : "undefined" });
  }
  if (t.isThrowStatement(s)) { const b = nb(); blocks[b].term = { kind: "throw", value: gen(s.argument) }; return b; }
  if (t.isTryStatement(s)) return compileTry(s, ctx);

  if (containsSuspCall(s)) throw new Error("a suspendable call must be a statement: `const x = f(...)` or `f(...);`");
  const b = nb(); blocks[b].lines.push(gen(s)); blocks[b].term = { kind: "jump", to: next }; return b; // gen() of a statement already ends in ;
}

// try/catch/finally. catch+finally desugars to nested try/finally(try/catch) so only the
// two pure forms are lowered. Handlers live on the serializable stack F.__h, so a suspend
// inside a try survives migration with its catch/finally target intact.
function compileTry(s: t.TryStatement, ctx: Ctx): number {
  const { next, tryDepth } = ctx;
  if (s.handler && s.finalizer) return compileTry(t.tryStatement(t.blockStatement([t.tryStatement(s.block, s.handler, null)]), null, s.finalizer), ctx);
  // tryStack records, per enclosing try, whether it has a finally — so an abrupt exit
  // (return/break/continue) knows which handlers to pop and won't silently skip a finally.

  if (s.handler) {                                                 // pure try/catch
    const inner: Ctx = { ...ctx, tryDepth: tryDepth + 1, tryStack: [...ctx.tryStack, { hasFinally: false }] };
    const entry = nb(), catchB = nb();
    const bodyEnd = nb(); blocks[bodyEnd].lines.push("F.__h.pop();"); blocks[bodyEnd].term = { kind: "jump", to: next };
    const body = compileStmts(blockStmts(s.block), { ...inner, next: bodyEnd });
    blocks[entry].term = { kind: "pushTry", catch: catchB, fin: null, to: body };
    const param = s.handler.param ? (s.handler.param as t.Identifier).name : null;
    if (param) blocks[catchB].lines.push(`F.${param} = F.__err;`);
    const catchEnd = nb(); blocks[catchEnd].lines.push("F.__h.pop();"); blocks[catchEnd].term = { kind: "jump", to: next };
    blocks[catchB].term = { kind: "jump", to: compileStmts(blockStmts(s.handler.body), { ...inner, next: catchEnd }) }; // handler still live during catch
    return entry;
  }

  // pure try/finally
  const entry = nb(), finB = nb();
  const inner: Ctx = { ...ctx, tryDepth: tryDepth + 1, tryStack: [...ctx.tryStack, { hasFinally: true, finB }] };
  const bodyEnd = nb();
  blocks[bodyEnd].lines.push("F.__h[F.__h.length - 1].state = 2;", "F.__c = null;");
  blocks[bodyEnd].term = { kind: "jump", to: finB };
  const body = compileStmts(blockStmts(s.block), { ...inner, next: bodyEnd });
  blocks[entry].term = { kind: "pushTry", catch: null, fin: finB, to: body };
  const finEnd = nb();
  blocks[finB].term = { kind: "jump", to: compileStmts(blockStmts(s.finalizer as t.BlockStatement), { ...ctx, next: finEnd, tryStack: [...ctx.tryStack, { hasFinally: false }] }) };
  blocks[finEnd].term = { kind: "finish", after: next };
  return entry;
}

// An abrupt exit (return/break/continue) crossing enclosing trys must pop each try/catch's
// handler and RUN each crossed finally (in order) before reaching its target. The completion
// (F.__c) and the finally chain are recorded; __unwindStep + the finally `finish` drive it.
function abruptExit(ctx: Ctx, targetDepth: number, completion: Completion): number {
  const crossed = ctx.tryStack.slice(targetDepth).reverse();      // innermost -> outermost
  const b = nb();
  if (!crossed.some((x) => x.hasFinally)) {                        // no finally crossed: just pop handlers and go
    for (let i = 0; i < crossed.length; i++) blocks[b].lines.push("F.__h.pop();");
    blocks[b].term = completion.ctype === "return" ? { kind: "ret", value: completion.value } : { kind: "jump", to: completion.targetRaw };
    return b;
  }
  // completion is a clean discriminated union (return has value, break/continue has targetRaw),
  // but Term's "abrupt" case stores both fields regardless of ctype (see its declaration above).
  const c = completion as { ctype: "return" | "break" | "continue"; value?: string; targetRaw?: number };
  blocks[b].term = { kind: "abrupt", ctype: c.ctype, value: c.value, targetRaw: c.targetRaw, steps: crossed.map((x) => x.hasFinally ? { finRaw: x.finB! } : { pop: 1 }) };
  return b;
}

function compileFn(node: t.FunctionDeclaration): string {
  const fnName = (node.id as t.Identifier).name;
  blocks = [];
  if (SOURCE_MAP) curLine = node.loc!.start.line;
  const END = nb(); blocks[END].term = { kind: "ret", value: "undefined" };   // fall off the end -> return undefined, matching plain-JS semantics
  const entry = compileStmts(node.body.body, { next: END, brk: END, brkDepth: 0, cont: END, contDepth: 0, tryDepth: 0, tryStack: [], labels: {}, label: undefined });
  const boot = nb(); blocks[boot].term = { kind: "jump", to: entry };  // pc 0 -> entry
  const ids = [boot, ...Array.from(blocks.keys()).filter((i) => i !== boot)];
  const remap = new Map(ids.map((id, i) => [id, i]));
  const R = (id: number): number => remap.get(id)!;
  const P = (id: number | null): string | number => (id == null ? "null" : R(id));   // remapped pc, or null for absent catch/finally
  const emitTerm = (tm: Term): string => {
    if (tm.kind === "jump") return `F.pc = ${R(tm.to)}; break;`;
    if (tm.kind === "susp") return `F.pc = ${R(tm.resume)}; return ${tm.op};`;
    if (tm.kind === "call") return `F.pc = ${R(tm.resume)}; return { op: "call", fn: ${JSON.stringify(tm.fn)}, args: [${tm.args}] };`;
    if (tm.kind === "branch") return `if (${tm.cond}) { F.pc = ${R(tm.then)}; } else { F.pc = ${R(tm.else)}; } break;`;
    if (tm.kind === "ret") return `return { op: "return", value: ${tm.value} };`;
    if (tm.kind === "throw") return `{ const __t = __dispatch(F, ${tm.value}); if (__t == null) return { op: "throw", value: ${tm.value} }; F.pc = __t; break; }`;
    if (tm.kind === "pushTry") return `(F.__h || (F.__h = [])).push({ catch: ${P(tm.catch)}, fin: ${P(tm.fin)}, state: 0 }); F.pc = ${R(tm.to)}; break;`;
    if (tm.kind === "finish") return `{ F.__h.pop(); const __c = F.__c; if (!__c) { F.pc = ${R(tm.after)}; break; } if (__c.type === "throw") { F.__c = null; const __t = __dispatch(F, __c.arg); if (__t == null) return { op: "throw", value: __c.arg }; F.pc = __t; break; } const __p = __unwindStep(F); if (__p != null) { F.pc = __p; break; } F.__c = null; if (__c.type === "return") return { op: "return", value: __c.value }; F.pc = __c.target; break; }`;
    if (tm.kind === "abrupt") {                                       // return/break/continue crossing a finally: record completion + drive its finally chain
      const steps = "[" + tm.steps.map((s) => "pop" in s ? `{ pop: ${s.pop} }` : `{ fin: ${R(s.finRaw)} }`).join(", ") + "]";
      const rec = tm.ctype === "return" ? `{ type: "return", value: ${tm.value}, steps: ${steps} }` : `{ type: ${JSON.stringify(tm.ctype)}, target: ${R(tm.targetRaw!)}, steps: ${steps} }`;
      const exec = tm.ctype === "return" ? "return { op: \"return\", value: __c.value };" : "F.pc = __c.target; break;";
      return `F.__c = ${rec}; { const __p = __unwindStep(F); if (__p != null) { F.pc = __p; break; } const __c = F.__c; F.__c = null; ${exec} }`;
    }
    throw new Error("bad terminator " + (tm as { kind: string }).kind);
  };
  const caseText = new Map<number, string>();   // raw id -> the case's full emitted text (lines + term)
  const cases = ids.map((id) => { const blk = blocks[id]; const lines = blk.lines.slice(); lines.push(emitTerm(blk.term!)); caseText.set(id, lines.join("\n")); return `      case ${R(id)}:\n        ${lines.join("\n        ")}`; }).join("\n");
  if (SOURCE_MAP) { const sites: Record<number, number | undefined> = {}; for (const id of ids) sites[R(id)] = blocks[id].line; fnSites[fnName] = sites; }  // pc -> source line

  // §5 stop-rule metadata (docs/migrate-arm.md): per resume state, the frame slots the
  // segment entered there references before its next suspension. Computed on the EMITTED
  // text (F.<name> occurrences — reads, writes, and term expressions alike), closed over
  // every successor a step can reach without returning from the step function. Throw and
  // finally terms over-approximate with every handler in the function: coming home early
  // is a lost optimization, running a segment beside a handle is a wrong program.
  {
    const allCatch: number[] = [], allFin: number[] = [], allAbrupt: number[] = [];
    for (const id of ids) { const tm = blocks[id].term!;
      if (tm.kind === "pushTry") { if (tm.catch != null) allCatch.push(tm.catch); if (tm.fin != null) allFin.push(tm.fin); }
      if (tm.kind === "abrupt" && tm.targetRaw != null) allAbrupt.push(tm.targetRaw);
    }
    const succs = (id: number): number[] => { const tm = blocks[id].term!;
      switch (tm.kind) {
        case "jump": return [tm.to];
        case "branch": return [tm.then, tm.else];
        case "pushTry": return [tm.to];
        case "throw": return [...allCatch, ...allFin];
        case "finish": return [tm.after, ...allCatch, ...allFin, ...allAbrupt];
        case "abrupt": return [...(tm.targetRaw != null ? [tm.targetRaw] : []), ...allFin];
        default: return [];                       // susp/call/ret end the step — the next segment gets its own check
      }
    };
    // args are referenced by ELEMENT (`this` lowers to F.args[0], params to F.args[i]) —
    // keep that precision, or one excised instance would park every param-using segment.
    // A dyn park whose RECEIVER is a DIRECT slot (F.x / F.args[i]) is exempted first:
    // the pump's dispatch is handle-aware by construction (twin / machine / home), so a
    // handle IN that slot must not trip the stop rule. A receiver that is a PATH through
    // a slot (F.args[0].svc) stays scanned — evaluating it on a handle would misread,
    // so the segment correctly parks home. Argument expressions always stay scanned.
    const refsOf = (id: number): Set<string> => {
      const out = new Set<string>();
      const text = caseText.get(id)!.replace(/\bop: "dyn", recv: F\.(?:args\[\d+\]|[A-Za-z_$][\w$]*)(?=,)/g, 'op: "dyn"');
      for (const m of text.matchAll(/\bF\.([A-Za-z_$][\w$]*)(\[(\d+)\])?/g)) {
        if (m[1] === "pc") continue;
        out.add(m[1] === "args" && m[3] !== undefined ? `args[${m[3]}]` : m[1]);
      }
      return out;
    };
    const table: Record<number, string[]> = {};
    for (const id of ids) {
      const seen = new Set<number>([id]), refs = new Set<string>();
      const walk = [id];
      while (walk.length) { const b = walk.pop()!; for (const r of refsOf(b)) refs.add(r); for (const s of succs(b)) if (!seen.has(s)) { seen.add(s); walk.push(s); } }
      if (refs.size) table[R(id)] = [...refs].sort();
    }
    fnSlots[fnName] = table;
  }
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
function remotableLocals(p: NodePath<t.FunctionDeclaration>): Set<string> {
  const remotable = new Set<string>();
  const isDataResource = (name: unknown): boolean => { const ns = String(name).split(".")[0]; return TIER_OF[ns] === "server"; };  // any server-pinned namespace (api.*, db.*, …)
  p.traverse({ VariableDeclarator(v) {                            // const L = yield R(tier, "<server-ns>.*")
    const init = v.node.init;
    if (t.isYieldExpression(init) && t.isCallExpression(init.argument) && t.isIdentifier(init.argument.callee, { name: "R" })
      && t.isStringLiteral(init.argument.arguments[1]) && isDataResource(init.argument.arguments[1].value) && t.isIdentifier(v.node.id)) remotable.add(v.node.id.name);
  } });
  return remotable;
}

function insertDerefGuards(p: NodePath<t.FunctionDeclaration>): Set<string> {
  const remotable = remotableLocals(p);
  if (!remotable.size) return remotable;

  // Collect, per statement, the remotable locals READ at that statement's own level. getStatementParent
  // attaches a read to its nearest enclosing statement, so a read in an if-test lands on the IfStatement
  // and a read in the body lands on the body statement — the right guard placement either way.
  const reads = new Map<t.Node, { path: NodePath; locals: Set<string> }>();   // stmt node -> { path, locals:Set }
  p.traverse({ Identifier(ip) {
    const name = ip.node.name;
    if (!remotable.has(name) || !ip.isReferencedIdentifier()) return;   // reads only (not the binding / write target)
    const stmt = ip.getStatementParent();
    if (!stmt) return;
    if (!reads.has(stmt.node)) reads.set(stmt.node, { path: stmt, locals: new Set() });
    reads.get(stmt.node)!.locals.add(name);
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
  const survive = new Map<NodePath, Set<string>>();                // path -> Set(locals) to actually guard
  for (const { path, locals } of reads.values()) survive.set(path, new Set(locals));
  const hasMigration = (sp: NodePath): boolean => { let m = false; sp.traverse({ YieldExpression() { m = true; }, CallExpression(cp) { const c = cp.node.callee; if (t.isIdentifier(c) && suspSet.has(c.name)) m = true; } }); return m; };
  const isControlFlow = (sp: NodePath): boolean => sp.isIfStatement() || sp.isForStatement() || sp.isWhileStatement() || sp.isDoWhileStatement()
    || sp.isForOfStatement() || sp.isForInStatement() || sp.isSwitchStatement() || sp.isTryStatement() || sp.isLabeledStatement() || sp.isBlockStatement();
  const containers = new Map<unknown, NodePath[]>();                // sibling array -> its array of sibling paths
  for (const { path } of reads.values()) if (Array.isArray(path.container) && !containers.has(path.container)) containers.set(path.container, path.parentPath!.get(path.listKey!) as NodePath[]);
  for (const sibs of containers.values()) {
    const mat = new Set<string>();
    for (const sp of sibs) {
      const barrier = hasMigration(sp) || isControlFlow(sp);
      const entry = reads.get(sp.node);
      if (entry && !barrier) { const s = survive.get(entry.path)!; for (const L of entry.locals) { if (mat.has(L)) s.delete(L); else mat.add(L); } }  // prune reads already available
      if (barrier) mat.clear();                                   // a hop or a join: nothing is known-materialized afterward
    }
  }

  for (const [path, locals] of survive) {
    if (!locals.size) continue;
    const g = [...locals].map((L) => t.ifStatement(t.callExpression(t.identifier("isHandle"), [t.identifier(L)]),
      t.blockStatement([t.expressionStatement(t.assignmentExpression("=", t.identifier(L),
        t.yieldExpression(t.callExpression(t.identifier("R"), [t.stringLiteral("@deref"), t.stringLiteral("deref"), t.identifier(L)]))))])));
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
function rootOfMember(node: t.Node): string | null {               // the base identifier a member chain hangs off
  let o = node;
  while (t.isMemberExpression(o)) o = o.object;
  return t.isIdentifier(o) ? o.name : null;
}
function insertWriteBacks(p: NodePath<t.FunctionDeclaration>, remotable: Set<string>): void {
  if (!remotable.size) return;
  const backs = new Map<t.Node, { path: NodePath; locals: Set<string> }>();   // statement node -> { path, locals } to write back after it
  const note = (target: t.Node, ip: NodePath): void => {          // target is the assignment/update LHS
    if (!t.isMemberExpression(target)) return;                    // only member mutations propagate (a rebind doesn't touch the object)
    const root = rootOfMember(target);
    if (!root || !remotable.has(root)) return;
    const stmt = ip.getStatementParent();
    if (!stmt) return;
    if (!backs.has(stmt.node)) backs.set(stmt.node, { path: stmt, locals: new Set() });
    backs.get(stmt.node)!.locals.add(root);
  };
  p.traverse({
    AssignmentExpression(ap) { note(ap.node.left, ap); },         // L[i].x = v   (any operator: =, +=, …)
    UpdateExpression(up) { note(up.node.argument, up); },         // L[i].x++ / --L.x
  });
  for (const { path, locals } of backs.values()) {
    const wb = [...locals].map((L) => t.expressionStatement(
      t.yieldExpression(t.callExpression(t.identifier("R"), [t.stringLiteral("@writeback"), t.stringLiteral("writeback"), t.identifier(L)]))));
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
function localNamesOf(p: NodePath<t.FunctionDeclaration>): Set<string> {   // params + declared locals + catch params
  const names = new Set(p.node.params.filter((x): x is t.Identifier => t.isIdentifier(x)).map((x) => x.name));
  p.traverse({ VariableDeclarator(v) { if (t.isIdentifier(v.node.id)) names.add(v.node.id.name); },
    CatchClause(c) { if (c.node.param && t.isIdentifier(c.node.param)) names.add(c.node.param.name); } });
  return names;
}
function wrapBase(memberPath: NodePath): void {                    // member.object -> __dirty(member.object), once
  const objPath = memberPath.get("object") as NodePath;
  if (t.isCallExpression(objPath.node) && t.isIdentifier(objPath.node.callee, { name: "__dirty" })) return;
  objPath.replaceWith(t.callExpression(t.identifier("__dirty"), [objPath.node as t.Expression]));
  objPath.skip();                                                // don't descend into the wrapper just created
}
function insertDirtyBarriers(p: NodePath<t.FunctionDeclaration>): void {
  const locals = localNamesOf(p);
  const rooted = (member: t.Node): boolean => { const r = rootOfMember(member); return !!r && locals.has(r); };   // a continuation root, not a global
  p.traverse({
    AssignmentExpression(ap) { const tgt = ap.node.left; if (t.isMemberExpression(tgt) && rooted(tgt)) wrapBase(ap.get("left") as NodePath); },
    UpdateExpression(up) { const tgt = up.node.argument; if (t.isMemberExpression(tgt) && rooted(tgt)) wrapBase(up.get("argument") as NodePath); },
    CallExpression(cp) { const c = cp.node.callee; if (t.isMemberExpression(c) && !c.computed && t.isIdentifier(c.property) && MUTATOR_METHODS.has(c.property.name) && rooted(c)) wrapBase(cp.get("callee") as NodePath); },
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
const FORIN_HELPER  = "const __forInKeys = (o) => { const a = []; for (const k in o) a.push(k); return a; };";                                            // for-in key order (incl. inherited enumerable)
const OBJREST_HELPER = "const __objRest = (o, taken) => { const r = {}; for (const k of Object.keys(o)) if (!taken.includes(k)) r[k] = o[k]; return r; };"; // { ...rest } = own enumerable minus taken

// Bind `target` (an Identifier / pattern / default) from the value `access` reads, appending
// the resulting simple declarations to `out`. Recurses through nested patterns and defaults.
// target/pattern are typed as t.Node throughout this trio (bindValue/flattenPattern/callers) —
// each is discriminated at runtime via t.isXxx checks, not by the caller pre-narrowing a union
// of Identifier/AssignmentPattern/ArrayPattern/ObjectPattern that Babel's own LVal/PatternLike
// types don't cleanly unify either.
function bindValue(target: t.Node, access: t.Expression, out: t.Statement[], fresh: () => string, kind: t.VariableDeclaration["kind"]): void {
  const decl = (name: string, init: t.Expression) => out.push(t.variableDeclaration(kind, [t.variableDeclarator(t.identifier(name), init)]));
  if (t.isAssignmentPattern(target)) {                            // x = D  (default applies when the slot is undefined)
    const p = fresh();
    decl(p, access);
    const chosen = t.conditionalExpression(t.binaryExpression("===", t.identifier(p), t.identifier("undefined")), target.right, t.identifier(p));
    if (t.isIdentifier(target.left)) { decl(target.left.name, chosen); return; }
    const q = fresh(); decl(q, chosen); flattenPattern(target.left, t.identifier(q), out, fresh, kind); return;
  }
  if (t.isIdentifier(target)) { decl(target.name, access); return; }
  const tmp = fresh(); decl(tmp, access); flattenPattern(target, t.identifier(tmp), out, fresh, kind);   // nested pattern: eval the source once
}

// Expand a destructuring pattern reading from `access` into a flat list of simple declarations.
// `access` is embedded in several sibling positions, so clone it each time — an AST node must have
// a single parent or the later F.x rewrite traversal mishandles it.
function flattenPattern(pattern: t.Node, access: t.Expression, out: t.Statement[], fresh: () => string, kind: t.VariableDeclaration["kind"]): void {
  const A = () => t.cloneNode(access, true);
  if (t.isObjectPattern(pattern)) {
    const taken: string[] = [];                                   // keys consumed so far, for a trailing ...rest
    let hasComputed = false;
    for (const prop of pattern.properties) {
      if (t.isRestElement(prop)) {
        if (hasComputed) throw new Error("tierless: a computed key together with ...rest in object destructuring is not supported (lift it to a local first)");
        USED_OBJREST = true;
        bindValue(prop.argument, t.callExpression(t.identifier("__objRest"), [A(), t.arrayExpression(taken.map((k) => t.stringLiteral(k)))]), out, fresh, kind);
        continue;
      }
      const idKey = t.isIdentifier(prop.key) && !prop.computed;   // { a: v } -> access.a
      const computed = !idKey;                                    // { "a-b": v } / { 0: v } / { [k]: v } -> access[key]
      if (prop.computed) hasComputed = true; else taken.push(idKey ? (prop.key as t.Identifier).name : String((prop.key as t.StringLiteral | t.NumericLiteral).value));
      bindValue(prop.value, t.memberExpression(A(), idKey ? t.identifier((prop.key as t.Identifier).name) : prop.key as t.Expression, computed), out, fresh, kind);
    }
    return;
  }
  // ArrayPattern: normalize the source to an array ONCE — a real array passes through by reference
  // (zero copy), any other iterable (Set/Map/string/array-like) materializes. Correct for all, cheap
  // for the common case. Element reads are then index accesses and ...rest is a .slice.
  const arrPattern = pattern as t.ArrayPattern;
  const arr = fresh();
  out.push(t.variableDeclaration(kind, [t.variableDeclarator(t.identifier(arr), t.conditionalExpression(
    t.callExpression(t.memberExpression(t.identifier("Array"), t.identifier("isArray")), [A()]),
    A(),
    t.callExpression(t.memberExpression(t.identifier("Array"), t.identifier("from")), [A()])))]));
  arrPattern.elements.forEach((el, i) => {
    if (el == null) return;                                       // elision: const [, x] = a
    if (t.isRestElement(el)) { bindValue(el.argument, t.callExpression(t.memberExpression(t.identifier(arr), t.identifier("slice")), [t.numericLiteral(i)]), out, fresh, kind); return; }
    bindValue(el, t.memberExpression(t.identifier(arr), t.numericLiteral(i), true), out, fresh, kind);
  });
}

// `const/let PATTERN = INIT`  ->  `const _t = INIT; <extractions>`. Any RHS that suspends is
// bound to the temp first, so normalize lowers it like any other suspension.
function desugarDestructuring(fnPath: NodePath<t.FunctionDeclaration>, fresh: () => string): void {
  for (let guard = 0; guard < 100000; guard++) {
    let acted = false;
    fnPath.traverse({ VariableDeclaration(p) {
      if (acted) return;
      if (t.isForStatement(p.parent) && p.parent.init === p.node) return;   // a C-style for head keeps its own init
      if (!p.node.declarations.some((d) => !t.isIdentifier(d.id))) return;  // all bindings simple: nothing to do
      const out: t.Statement[] = [];
      for (const d of p.node.declarations) {
        if (t.isIdentifier(d.id)) { out.push(t.variableDeclaration(p.node.kind, [d])); continue; }
        const tmp = fresh();
        out.push(t.variableDeclaration(p.node.kind, [t.variableDeclarator(t.identifier(tmp), d.init as t.Expression)]));
        flattenPattern(d.id, t.identifier(tmp), out, fresh, p.node.kind);
      }
      p.replaceWithMultiple(out); acted = true; p.stop();
    } });
    if (!acted) break;
  }
}

// for-of / for-in  ->  materialize the sequence once, then a C-style index loop the compiler
// already lowers. for-of uses Array.from (any iterable); for-in uses __forInKeys (enumerable
// keys, inherited included). The eager materialization is the price of migratability: a lazy
// native iterator holds a closure/native cursor that can't be serialized and shipped anyway.
function desugarForEach(fnPath: NodePath<t.FunctionDeclaration>, fresh: () => string): void {
  for (let guard = 0; guard < 100000; guard++) {
    let acted = false;
    const visit = (p: NodePath<t.ForOfStatement | t.ForInStatement>): void => {
      if (acted) return;
      const node = p.node, isOf = t.isForOfStatement(node);
      if (isOf && (node as t.ForOfStatement).await) throw new Error("tierless: for-await-of is not supported (no async in this model)");
      const s = fresh(), i = fresh();
      const src = isOf ? t.callExpression(t.memberExpression(t.identifier("Array"), t.identifier("from")), [node.right])
        : (USED_FORIN = true, t.callExpression(t.identifier("__forInKeys"), [node.right]));
      const elem = t.memberExpression(t.identifier(s), t.identifier(i), true);   // _s[_i]
      const bind = t.isVariableDeclaration(node.left)
        ? t.variableDeclaration(node.left.kind, [t.variableDeclarator(node.left.declarations[0].id, elem)])   // const x / const [a,b] = _s[_i]
        : t.expressionStatement(t.assignmentExpression("=", node.left as t.LVal, elem));                      // x = _s[_i]
      const body = t.isBlockStatement(node.body) ? node.body.body : [node.body];
      const loop = t.forStatement(
        t.variableDeclaration("let", [t.variableDeclarator(t.identifier(i), t.numericLiteral(0))]),
        t.binaryExpression("<", t.identifier(i), t.memberExpression(t.identifier(s), t.identifier("length"))),
        t.assignmentExpression("=", t.identifier(i), t.binaryExpression("+", t.identifier(i), t.numericLiteral(1))),
        t.blockStatement([bind, ...body]));
      // A labeled `outer: for (x of xs)` must keep the label ON THE LOOP so `continue outer` still
      // targets a loop, not the wrapping block — move it onto the inner for and replace the label node.
      const parentPath = p.parentPath!;
      const labeled = parentPath.isLabeledStatement() && parentPath.node.body === node;
      const inner = labeled ? t.labeledStatement(t.identifier((parentPath.node as t.LabeledStatement).label.name), loop) : loop;
      const block = t.blockStatement([t.variableDeclaration("const", [t.variableDeclarator(t.identifier(s), src)]), inner]);
      (labeled ? parentPath : p).replaceWith(block);
      acted = true; p.stop();
    };
    fnPath.traverse({ ForOfStatement: visit, ForInStatement: visit });
    if (!acted) break;
  }
}

// Non-simple params (defaults, destructuring, rest) -> a plain arg identifier + a body prologue.
// A default becomes `if (x === undefined) x = D` (D may itself suspend); a pattern param becomes
// a fresh arg + `const {…} = _a` (then desugared); a rest becomes `const xs = F.args.slice(i)`.
function desugarParams(fnPath: NodePath<t.FunctionDeclaration>, fresh: () => string): void {
  const node = fnPath.node;
  if (!node.params.some((p) => !t.isIdentifier(p))) return;
  const prologue: t.Statement[] = [];
  node.params = node.params.map((param, i): t.Identifier | null => {
    if (t.isIdentifier(param)) return param;
    if (t.isRestElement(param)) {                                 // ...xs  ->  const xs = F.args.slice(i)  (xs is now a frame local)
      const slice = t.callExpression(t.memberExpression(t.memberExpression(t.identifier("F"), t.identifier("args")), t.identifier("slice")), [t.numericLiteral(i)]);
      if (t.isIdentifier(param.argument)) prologue.push(t.variableDeclaration("const", [t.variableDeclarator(param.argument, slice)]));
      else { const a = fresh(); prologue.push(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(a), slice)])); prologue.push(t.variableDeclaration("const", [t.variableDeclarator(param.argument as t.ArrayPattern | t.ObjectPattern, t.identifier(a))])); }
      return null;                                                // drop from the param list
    }
    let target: t.Node = param;
    let def: t.Expression | null = null;
    if (t.isAssignmentPattern(param)) { target = param.left; def = param.right; }
    const slot = t.isIdentifier(target) ? target.name : fresh();
    if (def) prologue.push(t.ifStatement(t.binaryExpression("===", t.identifier(slot), t.identifier("undefined")), t.expressionStatement(t.assignmentExpression("=", t.identifier(slot), def))));
    if (!t.isIdentifier(target)) prologue.push(t.variableDeclaration("const", [t.variableDeclarator(target as t.ArrayPattern | t.ObjectPattern, t.identifier(slot))]));   // pattern param -> destructure the slot
    return t.identifier(slot);
  }).filter((x): x is t.Identifier => x !== null);
  node.body.body.unshift(...prologue);
}

function desugarBindings(fnPath: NodePath<t.FunctionDeclaration>): void {
  let n = 0; const fresh = () => "__b" + (n++);
  desugarParams(fnPath, fresh);      // params first (their prologue may add destructuring / loops downstream)
  desugarForEach(fnPath, fresh);     // then loops (a for-of binding may itself be a pattern)
  desugarDestructuring(fnPath, fresh); // finally every pattern, incl. those the two passes above introduced
}

function lower(p: NodePath<t.FunctionDeclaration>): string {
  desugarBindings(p);                                             // for-of/for-in, destructuring, non-simple params -> simple forms
  // AUTO_WRITEBACK forces AUTO_DEREF (a write through a handle must first materialize it), so whenever
  // insertWriteBacks runs, insertDerefGuards just ran on the same p — reuse its remotable-locals scan
  // instead of re-traversing the function a second time for an identical result.
  const remotable = AUTO_DEREF ? insertDerefGuards(p) : null;      // before normalize: the guard's `L = deref(L)` is a suspension to hoist
  if (AUTO_WRITEBACK) insertWriteBacks(p, remotable!);             // non-null: configure() forces AUTO_DEREF whenever AUTO_WRITEBACK is set
  if (TRACK_WRITES) insertDirtyBarriers(p);                       // after writeback/deref — their analyses need the unwrapped mutation target
  normalize(p);                                                   // hoist suspensions out of expression positions first
  const node = p.node;
  const params = (node.params as t.Identifier[]).map((x) => x.name);   // desugarParams already reduced these to plain identifiers
  const locals = new Set<string>();
  p.traverse({ VariableDeclarator(v) { if (t.isIdentifier(v.node.id)) locals.add(v.node.id.name); } });
  p.traverse({ CatchClause(c) { if (c.node.param && t.isIdentifier(c.node.param)) locals.add(c.node.param.name); } });
  p.traverse({ CallExpression(cp) {                              // validate suspendable calls are statements in THIS function
    const c = cp.node.callee;
    if (!(t.isIdentifier(c) && suspSet.has(c.name))) return;
    if (cp.getFunctionParent()?.node !== node) throw new Error(`tierless: a call to suspendable function ${c.name}() inside a nested function / callback is not supported — lift it to a statement in the top-level function body (e.g. \`for (const x of xs) { const r = ${c.name}(x); }\`).`);
    const par = cp.parent;
    if (!((t.isVariableDeclarator(par) && par.init === cp.node) || (t.isExpressionStatement(par) && par.expression === cp.node))) throw new Error(`suspendable call ${c.name}(...) must be a statement, not a sub-expression`);
  } });
  p.traverse({ Identifier(ip) {
    const name = ip.node.name;
    if (name === "F" || !(params.includes(name) || locals.has(name))) return;
    const par = ip.parent;
    if (t.isMemberExpression(par) && par.property === ip.node && !par.computed) return;
    if (t.isObjectProperty(par) && par.key === ip.node && !par.computed) return;
    if (t.isVariableDeclarator(par) && par.id === ip.node) return;
    if (t.isCatchClause(par) && par.param === ip.node) return;
    if (t.isFunction(par)) return;
    // Scope-resolve the name: if it's bound by a NESTED function (its own param/local, shadowing the
    // frame local — e.g. `xs.map(x => x)` where `x` is also a frame local), leave it alone. A nested
    // BLOCK's local and a nested function closing OVER a frame local both still resolve to THIS
    // function, so they still rewrite to F.x. Without this, the name-based rewrite corrupts shadows.
    const binding = ip.scope.getBinding(name);
    const bindingFn = binding && binding.path.getFunctionParent();
    if (bindingFn && bindingFn.node !== node) return;
    if (params.includes(name)) ip.replaceWith(t.memberExpression(t.memberExpression(t.identifier("F"), t.identifier("args")), t.numericLiteral(params.indexOf(name)), true));
    else ip.replaceWith(t.memberExpression(t.identifier("F"), t.identifier(name)));
    ip.skip();
  } });
  p.traverse({ VariableDeclaration(v) {
    if (isSusp(v.node) || callSusp(v.node)) return;               // leave suspensions for compileStmt
    if (t.isForStatement(v.parent) && v.parent.init === v.node) return;
    const assigns = v.node.declarations.filter((d) => d.init).map((d) => t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("F"), t.identifier((d.id as t.Identifier).name)), d.init as t.Expression)));
    if (assigns.length) v.replaceWithMultiple(assigns); else v.remove();
  } });
  return compileFn(node);
}

// A suspension is only migratable if it sits directly in a top-level function that becomes a
// PROGRAM. Inside a nested function / callback / method it would be invoked synchronously by
// native code (Array.map/sort, a method dispatch) that cannot yield or migrate, so reject it
// with a precise error rather than silently miscompile. (Runs on tier calls right after the
// allow-list rewrite; suspendable-call-in-callback is caught per-function in lower().)
function checkNestedSuspensions(ast: t.File): void {
  traverse(ast, { YieldExpression(p) {
    if (!isResYield(p.node)) return;
    const fn = p.getFunctionParent();
    if (fn && t.isFunctionDeclaration(fn.node) && fn.parentPath && (t.isProgram(fn.parentPath.node)
      || (fn.parentPath.isExportNamedDeclaration() && t.isProgram(fn.parentPath.parentPath!.node)))) return;
    const nameArg = (p.node.argument as t.CallExpression).arguments[1];
    const name = t.isStringLiteral(nameArg) ? nameArg.value : "resource";
    const where = !fn ? "top-level module code"
      : t.isObjectMethod(fn.node) || t.isClassMethod(fn.node) ? "an object/class method"
        : "a nested function / callback";
    throw new Error(`tierless: a tier call (${name}) inside ${where} is not supported — a callback runs synchronously inside native code (e.g. Array.map/sort) that cannot suspend or migrate. Lift it to a statement in a top-level function, e.g. \`for (const x of xs) { const r = ${name}(x); }\`.`);
  } });
}

interface FnEntry { p?: NodePath<t.FunctionDeclaration>; exported: boolean }

// Collect the compilable top-level functions: plain FunctionDeclarations and NAMED exported
// ones (`export function f() {}`). Every other top-level statement (imports, consts, classes)
// is kept verbatim ahead of the output, so a "use tierless" module keeps its module scope. A file
// directive ("use tierless"/"use strict") is dropped — it addressed the build, not the runtime.
function collectProgram(ast: t.File) {
  const fnPaths = new Map<string, FnEntry>();                     // name -> { p, exported }
  const rest: t.Statement[] = [];
  for (const node of ast.program.body) {
    if (t.isFunctionDeclaration(node) && node.id) { fnPaths.set(node.id.name, { exported: false }); continue; }
    if (t.isExportNamedDeclaration(node) && t.isFunctionDeclaration(node.declaration) && node.declaration.id) { fnPaths.set(node.declaration.id.name, { exported: true }); continue; }
    if (t.isExpressionStatement(node) && t.isStringLiteral(node.expression) && node.expression.value.startsWith("use ")) continue;
    rest.push(node);
  }
  traverse(ast, { FunctionDeclaration(p) {                        // attach paths (traverse for correct scope info)
    const name = p.node.id && p.node.id.name;
    const par = p.parentPath;
    if (!name || !fnPaths.has(name)) return;
    if (t.isProgram(p.parent) || (par.isExportNamedDeclaration() && t.isProgram(par.parent))) fnPaths.get(name)!.p = p;
  } });
  // suspendability: directly contains a yield (tier resource), or transitively calls one that does
  const calls = new Map<string, Set<string>>(); const directly = new Set<string>();
  for (const [name, { p }] of fnPaths) {
    let y = false; const cs = new Set<string>();
    p!.traverse({ YieldExpression() { y = true; }, CallExpression(cp) { const c = cp.node.callee; if (t.isIdentifier(c) && fnPaths.has(c.name)) cs.add(c.name); } });
    if (y) directly.add(name); calls.set(name, cs);
  }
  const susp = new Set(directly);
  for (let changed = true; changed;) { changed = false; for (const [name, cs] of calls) if (!susp.has(name) && [...cs].some((c) => susp.has(c))) { susp.add(name); changed = true; } }
  return { fnPaths, rest, susp, directly, calls };
}

// The module's own top-level RELATIVE import/export-from specifiers (`./`, `../`), in source
// form. The compiled machine keeps these verbatim (they sit in `kept`); when the Vite plugin
// emits the server copy to a different directory it rewrites them relative to that directory
// (see vite.mts). Bare specifiers (packages) resolve from node_modules unchanged, so they're
// not listed.
function relativeImports(rest: t.Statement[]): string[] {
  const specs: string[] = [];
  for (const n of rest) {
    const src = t.isImportDeclaration(n) || t.isExportNamedDeclaration(n) || t.isExportAllDeclaration(n) ? n.source : null;
    if (src && t.isStringLiteral(src) && src.value.startsWith(".")) specs.push(src.value);
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
function compileClassMethods(ast: t.File, progs: string[], meta: CompileMeta, rest: t.Statement[]): void {
  const stubProps: t.Statement[] = [];   // Cls.prototype.m.__tierless_program = "Cls$m" — what the dynamic call park dispatches on
  for (const top of ast.program.body) {
    const cls = t.isClassDeclaration(top) ? top
      : (t.isExportNamedDeclaration(top) || t.isExportDefaultDeclaration(top)) && t.isClassDeclaration(top.declaration) ? top.declaration
        : null;
    if (!cls) continue;
    if (!cls.id) { meta.methods.push({ class: "(default)", method: "*", program: null, error: "anonymous default-export class — name it to compile its methods" }); continue; }
    const clsName = cls.id.name;
    let compiledAny = false;
    // sibling methods with DIRECT tier calls return promises by construction — a sync
    // wrapper's `return this.post(...)` may safely become a dyn park (see lowerMethod)
    const tierSiblings = new Set<string>();
    for (const m of cls.body.body) {
      if (!t.isClassMethod(m) || !t.isIdentifier(m.key)) continue;
      let hit = false;
      t.traverseFast(m, (n) => {
        if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && t.isMemberExpression(n.callee.object)
          && t.isThisExpression(n.callee.object.object) && t.isIdentifier(n.callee.object.property) && TIER_OF["this." + n.callee.object.property.name]) hit = true;
      });
      if (hit) tierSiblings.add(m.key.name);
    }
    for (const m of [...cls.body.body]) {
      if (!t.isClassMethod(m) || m.kind !== "method" || m.static || m.computed || !t.isIdentifier(m.key)) continue;
      const mName = m.key.name;
      const progName = clsName + "$" + mName;
      try {
        const prog = lowerMethod(clsName, mName, m, progName, tierSiblings);
        if (!prog) continue;                                       // no tier calls — stays a plain method
        progs.push(prog);
        meta.programs.push(progName);
        meta.methods.push({ class: clsName, method: mName, program: progName });
        // keep the original under a mangled name; the visible method becomes the stub
        cls.body.body.push(t.classMethod("method", t.identifier("__tierless_orig_" + mName), m.params, m.body, false, false, false, m.async));
        m.params = [];                                             // stub reads `arguments`; original params would re-evaluate defaults
        m.body = t.blockStatement([t.returnStatement(t.conditionalExpression(
          t.binaryExpression("===", t.unaryExpression("typeof", t.identifier("__TIERLESS_METHOD__")), t.stringLiteral("function")),
          t.callExpression(t.identifier("__TIERLESS_METHOD__"), [t.stringLiteral(progName), t.thisExpression(),
            t.callExpression(t.memberExpression(t.identifier("Array"), t.identifier("from")), [t.identifier("arguments")])]),
          t.callExpression(t.memberExpression(t.thisExpression(), t.identifier("__tierless_orig_" + mName)), [t.spreadElement(t.identifier("arguments"))]),
        ))]);
        // stamp the stub with its program name: a compiled CALLER's dynamic park reads it
        // to push this method as a nested machine instead of awaiting an opaque promise
        stubProps.push(t.expressionStatement(t.assignmentExpression("=",
          t.memberExpression(t.memberExpression(t.memberExpression(t.identifier(clsName), t.identifier("prototype")), t.identifier(mName)), t.identifier("__tierless_program")),
          t.stringLiteral(progName))));
        compiledAny = true;
      } catch (e) {
        meta.methods.push({ class: clsName, method: mName, program: null, error: (e as Error).message.split("\n")[0] });
      }
    }
    // class identity for §5: excision stamps it onto the handle (h.cls), so a dynamic
    // call park can dispatch to a session twin or this class's machine WITHOUT the live
    // instance (docs/migrate-arm.md "the dispatch problem")
    if (compiledAny) stubProps.push(t.expressionStatement(t.assignmentExpression("=",
      t.memberExpression(t.memberExpression(t.identifier(clsName), t.identifier("prototype")), t.identifier("__tierless_cls")),
      t.stringLiteral(clsName))));
  }
  rest.push(...stubProps);   // `kept` is generated from rest — program-body pushes would never emit
}

// Residual awaits of MEMBER CALLS become dynamic call parks (docs/migrate-arm.md
// slice 3): `await x.m(a)` -> `yield D(x, "m", a)` — resolved at RUNTIME by the pump.
// Shared by the method and store-function lowerings; awaits that survive it reject.
// Only awaits BELONGING to the lowered function rewrite (an await's owner is its nearest
// enclosing function, arrows included) — an await inside a nested function is that
// closure's own suspension: it stays plain JS, runs wherever its segment runs, and any
// escaping promise is ownedUnit, so the §5 stop rule fences it.
function rewriteDynAwaits(file: t.File, fnNode: t.FunctionDeclaration): void {
  traverse(file, { AwaitExpression(ap) {
    if (ap.getFunctionParent()?.node !== fnNode) return;
    const arg = ap.node.argument;
    if (t.isCallExpression(arg) && t.isMemberExpression(arg.callee) && !arg.callee.computed && t.isIdentifier(arg.callee.property) && !arg.arguments.some((x) => t.isSpreadElement(x))) {
      const y = t.yieldExpression(t.callExpression(t.identifier("D"),
        [arg.callee.object as t.Expression, t.stringLiteral(arg.callee.property.name), ...(arg.arguments as t.Expression[])]));
      y.loc = ap.node.loc;
      ap.replaceWith(y);
    }
  } });
}

// ---- Pinia-style setup-store functions as PROGRAMS (docs/migrate-arm.md slice 3) --------
// The other unit real apps write: `defineStore(key, () => { ... async function f() {...}
// ... })`. Each async function DECLARED in the setup body whose awaits reach tier calls
// (directly or through awaited member calls) compiles into a PROGRAM named key$f, with
// its free setup-scope bindings (refs, service instances, sibling stores) rewritten to
// `__caps.<name>` — frame arg 0, built AT CALL TIME from the live closure, excised whole
// under §5 like a method's __self. The kept function becomes the same routing stub the
// class path uses, falling back to the untouched original. Per-function and graceful.
function compileStoreFunctions(ast: t.File, progs: string[], meta: CompileMeta): void {
  traverse(ast, { CallExpression(csp) {
    if (!t.isIdentifier(csp.node.callee, { name: "defineStore" })) return;
    const keyArg = csp.node.arguments[0];
    const setup = csp.get("arguments.1") as NodePath;
    if (!t.isStringLiteral(keyArg) || !(setup.isArrowFunctionExpression() || setup.isFunctionExpression())) return;
    const storeKey = keyArg.value.replace(/[^A-Za-z0-9_$]/g, "_");
    const body = setup.get("body");
    if (!body || Array.isArray(body) || !body.isBlockStatement()) return;

    for (const stmtPath of body.get("body")) {
      if (!stmtPath.isFunctionDeclaration() || !stmtPath.node.async || !stmtPath.node.id) continue;
      const fnName = stmtPath.node.id.name;
      const progName = storeKey + "$" + fnName;
      try {
        // free bindings — the caps. EVERYTHING bound outside the function captures:
        // setup-scope refs and services, and MODULE-scope imports/consts alike. Module
        // singletons (a router, i18n, a base store) are browser-owned live values the
        // slot rule couldn't fence as imports — through the caps handle they fence like
        // any owned slot, and the machine's server bundle needs (almost) no app imports.
        // An ASSIGNMENT to a captured binding can't be carried (the caps object is a
        // snapshot of bindings, not the bindings themselves) — the function stays original.
        const captures: string[] = [];
        const seen = new Set<string>();
        const within = (p: NodePath, anc: NodePath): boolean => p === anc || !!p.findParent((q) => q === anc);
        stmtPath.traverse({ ReferencedIdentifier(ip) {
          const name = ip.node.name;
          if (seen.has(name)) return;
          const b = ip.scope.getBinding(name);
          if (!b || within(b.scope.path, stmtPath)) return;               // fn-local or a true global: stays as-is
          seen.add(name); captures.push(name);
          for (const v of b.constantViolations) if (within(v, stmtPath)) throw new Error(`tierless: ${storeKey}.${fnName} assigns to captured binding '${name}' — a caps snapshot can't carry the write; the function stays uncompiled`);
        } });

        // isolated machine copy: function key$f(__caps, ...params) { body }, captures
        // rewritten to __caps.<name> — precisely, via the isolated file's own scope
        // (a nested shadowing declaration keeps its local meaning)
        const fnNode = t.functionDeclaration(t.identifier(progName), [t.identifier("__caps"), ...(stmtPath.node.params.map((x) => t.cloneNode(x, true)) as t.FunctionDeclaration["params"])], t.cloneNode(stmtPath.node.body, true));
        const file = t.file(t.program([fnNode]));
        const capSet = new Set(captures);
        traverse(file, { ReferencedIdentifier(ip) {
          if (!capSet.has(ip.node.name) || ip.scope.getBinding(ip.node.name)) return;   // bound in the copy = shadowed
          ip.replaceWith(t.memberExpression(t.identifier("__caps"), t.identifier(ip.node.name)));
        } });
        allowlist(file);
        rewriteDynAwaits(file, fnNode);
        let yields = 0;
        traverse(file, { YieldExpression(yp) { if (isResYield(yp.node) || isDynYield(yp.node)) yields++; } });
        if (!yields) continue;                                            // no tier-reaching awaits: stays a plain function
        traverse(file, { ThisExpression(tp) {
          throw new Error(`tierless: ${storeKey}.${fnName} uses \`this\` (line ${tp.node.loc?.start.line ?? "?"}) — setup-store functions have no instance; the function stays uncompiled`);
        } });
        traverse(file, { AwaitExpression(ap) {
          if (ap.getFunctionParent()?.node !== fnNode) return;     // a nested closure's own await: plain JS, stays
          throw new Error(`tierless: ${storeKey}.${fnName} awaits a non-call value (line ${ap.node.loc?.start.line ?? "?"}) — a pending native promise can't migrate; the function stays uncompiled`);
        } });
        let mpath: NodePath<t.FunctionDeclaration> | null = null;
        traverse(file, { FunctionDeclaration(p) { if (p.node.id?.name === progName) { mpath = p; p.stop(); } } });
        progs.push(lower(mpath!));
        meta.programs.push(progName);
        meta.methods.push({ class: "store:" + storeKey, method: fnName, program: progName });

        // keep the original under a mangled name; the visible function becomes the stub.
        // The caps literal is built AT CALL TIME from the live closure — always current,
        // no declaration-order constraints (function declarations hoist).
        const origName = "__tierless_orig_" + fnName;
        const orig = t.functionDeclaration(t.identifier(origName), stmtPath.node.params, stmtPath.node.body, false, stmtPath.node.async);
        const capsLit = t.objectExpression(captures.map((n) => t.objectProperty(t.identifier(n), t.identifier(n), false, true)));
        stmtPath.node.params = [];
        stmtPath.node.body = t.blockStatement([t.returnStatement(t.conditionalExpression(
          t.binaryExpression("===", t.unaryExpression("typeof", t.identifier("__TIERLESS_METHOD__")), t.stringLiteral("function")),
          t.callExpression(t.identifier("__TIERLESS_METHOD__"), [t.stringLiteral(progName), capsLit,
            t.callExpression(t.memberExpression(t.identifier("Array"), t.identifier("from")), [t.identifier("arguments")])]),
          t.callExpression(t.identifier(origName), [t.spreadElement(t.identifier("arguments"))]),
        ))]);
        stmtPath.insertAfter([orig,
          // the stamp a compiled CALLER's dynamic park dispatches on (sibling store calls)
          t.expressionStatement(t.assignmentExpression("=",
            t.memberExpression(t.identifier(fnName), t.identifier("__tierless_program")), t.stringLiteral(progName))),
          // the CAPS BUILDER for that dispatch: a sibling's frame arg 0 is ITS OWN caps,
          // which only this closure can build — a caller's dyn park must not hand the
          // sibling the caller's caps (checkAuth reading login's caps was the vikunja
          // auth cluster). Same literal the stub passes, built at dispatch time.
          t.expressionStatement(t.assignmentExpression("=",
            t.memberExpression(t.identifier(fnName), t.identifier("__tierless_caps")),
            t.arrowFunctionExpression([], t.cloneNode(capsLit))))]);
      } catch (e) {
        meta.methods.push({ class: "store:" + storeKey, method: fnName, program: null, error: (e as Error).message.split("\n")[0] });
      }
    }
  } });
}

// Lower ONE method in isolation: synthesize `function Cls$m(__self, ...params) { body }`
// in its own File, rewrite `this` (through arrows — they share the method's this; not
// through nested functions — they have their own), run the allow-list on it (which also
// absorbs `await` around tier calls), and reject what can't migrate with a precise
// reason. Returns null when the method makes no tier calls at all.
function lowerMethod(clsName: string, mName: string, m: t.ClassMethod, progName: string, tierSiblings: Set<string> = new Set()): string | null {
  const fnNode = t.functionDeclaration(t.identifier(progName), [t.identifier("__self"), ...(m.params.map((x) => t.cloneNode(x, true)) as t.FunctionDeclaration["params"])], t.cloneNode(m.body, true));
  const file = t.file(t.program([fnNode]));
  allowlist(file);                                                 // recognizes both this.<ns> and __self.<ns>, so it can run before the this-rewrite
  rewriteDynAwaits(file, fnNode);                                  // awaited member calls -> dynamic parks; bare awaits still reject below
  // a WRAPPER's `return this.m(...)` where m is a tier-calling sibling: the callee is
  // promise-returning by construction, so the tail joins the run as a dyn park — the
  // chains real services build out of delegation (update -> post) stay ONE traced run.
  traverse(file, { ReturnStatement(rp) {
    if (rp.getFunctionParent()?.node !== fnNode) return;
    const arg = rp.node.argument;
    if (t.isCallExpression(arg) && t.isMemberExpression(arg.callee) && !arg.callee.computed && t.isIdentifier(arg.callee.property)
      && tierSiblings.has(arg.callee.property.name)
      && (t.isThisExpression(arg.callee.object) || t.isIdentifier(arg.callee.object, { name: "__self" }))
      && !arg.arguments.some((x) => t.isSpreadElement(x))) {
      rp.node.argument = t.yieldExpression(t.callExpression(t.identifier("D"),
        [arg.callee.object as t.Expression, t.stringLiteral(arg.callee.property.name), ...(arg.arguments as t.Expression[])]));
    }
  } });
  let yields = 0;
  traverse(file, { YieldExpression(yp) { if (isResYield(yp.node) || isDynYield(yp.node)) yields++; } });
  if (!yields) return null;                                        // no tier calls: not a compilation candidate, no report either
  traverse(file, { Super(sp) {
    throw new Error(`tierless: ${clsName}.${mName} uses super (line ${sp.node.loc?.start.line ?? "?"}) — super dispatch can't be carried by the frame yet; the method stays uncompiled`);
  } });
  traverse(file, { ThisExpression(tp) {
    let f = tp.getFunctionParent();                                // arrows share the enclosing this
    while (f && f.isArrowFunctionExpression()) f = f.getFunctionParent();
    if (f && f.node === fnNode) tp.replaceWith(t.identifier("__self"));
  } });
  traverse(file, { AwaitExpression(ap) {
    if (ap.getFunctionParent()?.node !== fnNode) return;           // a nested closure's own await: plain JS, stays
    throw new Error(`tierless: ${clsName}.${mName} awaits a non-resource value (line ${ap.node.loc?.start.line ?? "?"}) — a pending native promise can't migrate; the method stays uncompiled`);
  } });
  let path: NodePath<t.FunctionDeclaration> | null = null;
  traverse(file, { FunctionDeclaration(p) { if (p.node.id?.name === progName) { path = p; p.stop(); } } });
  return lower(path!);
}

function compile(src: string, preamble: string): { code: string; meta: CompileMeta } {
  const ast = parser.parse(src, { sourceType: "module" }) as unknown as t.File;
  allowlist(ast);
  checkNestedSuspensions(ast);
  USED_FORIN = false; USED_OBJREST = false;
  fnSites = {}; fnSlots = {};
  const { fnPaths, rest, susp } = collectProgram(ast);
  suspSet = susp;

  const pure: string[] = [], progs: string[] = [], meta: CompileMeta = { programs: [], exported: [], pure: [], imports: relativeImports(rest), methods: [] };
  for (const [name, { p, exported }] of fnPaths) {                // pure single-tier fns run wholesale (lower() handles suspendable ones)
    if (suspSet.has(name)) { progs.push(lower(p!)); meta.programs.push(name); if (exported) meta.exported.push(name); }
    else { if (TRACK_WRITES) insertDirtyBarriers(p!); pure.push((exported ? "export " : "") + gen(p!.node)); meta.pure.push(name); }  // a pure helper can still mutate continuation state
  }
  compileClassMethods(ast, progs, meta, rest);                    // class methods with tier calls (their nodes sit in `rest` — the stub swap lands in `kept`)
  compileStoreFunctions(ast, progs, meta);                        // setup-store functions (defineStore closures) — stub swaps mutate nodes already in `rest`
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
    const refdIn = (name: string, text: string): boolean => new RegExp(`(?<![.\\w$"'])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
    let machineText = progs.join(",\n");
    const included = new Set<number>();
    // referenced TOP-LEVEL BINDINGS (const config values, arrow helpers) join the closure
    // like pure fns — the machine text names them, and without their declarations esbuild
    // treats them as globals and the migrated method dies at runtime. Classes stay
    // excluded by design (the machine reaches instances through frames, never constructs).
    const restDecls = rest
      .map((n) => (t.isExportNamedDeclaration(n) && n.declaration && t.isVariableDeclaration(n.declaration) ? n.declaration : n))
      .filter((n): n is t.VariableDeclaration => t.isVariableDeclaration(n));
    const declNames = restDecls.map((n) => n.declarations.map((d) => (t.isIdentifier(d.id) ? d.id.name : null)).filter((x): x is string => !!x));
    const declIncluded = new Set<number>();
    for (let changed = true; changed;) {
      changed = false;
      meta.pure.forEach((name, i) => {
        if (!included.has(i) && refdIn(name, machineText)) { included.add(i); machineText += "\n" + pure[i]; changed = true; }
      });
      declNames.forEach((names, i) => {
        if (!declIncluded.has(i) && names.some((nm) => refdIn(nm, machineText))) { declIncluded.add(i); machineText += "\n" + gen(restDecls[i]); changed = true; }
      });
    }
    const keptPure = [...included].sort((a, b) => a - b).map((i) => pure[i]);
    const keptDecls = [...declIncluded].sort((a, b) => a - b).map((i) => gen(restDecls[i]));   // original order: decls may reference each other
    const refd = (name: string): boolean => refdIn(name, machineText);
    const keptImports = rest
      .filter((n): n is t.ImportDeclaration => t.isImportDeclaration(n))
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

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface CompileOptions {
  /** Extra allow-list namespaces merged over { api: "server", commit: "browser" }. */
  resources?: Record<string, string>;
  filename?: string;
  preamble?: string;
  autoDeref?: boolean;
  autoWriteback?: boolean;
  trackWrites?: boolean;
  sourceMap?: boolean;
}
interface CompileMeta {
  programs: string[];
  /** Exported suspendable functions — the module's actions surface. */
  exported: string[];
  pure: string[];
  /** Top-level relative import/export-from specifiers, in source form (for server-emit rewriting). */
  imports: string[];
  /** Per-method outcome for top-level classes: compiled into `program`, or kept
   *  original with the blocking `error`. Methods without tier calls aren't listed. */
  methods: Array<{ class: string; method: string; program: string | null; error?: string }>;
  /** MACHINE-ONLY server module for class-method compilation (docs/migrate-arm.md): the
   *  programs, module-level helper functions, and ONLY the imports machine code actually
   *  references — the kept classes and their construction-time graph (http factories,
   *  framework wiring) stay out, so the module loads in plain Node. The migrate arm's
   *  gateway resolves this; absent when no class method compiled. */
  serverCode?: string;
}
interface FunctionReport {
  name: string;
  exported: boolean;
  suspendable: boolean;
  direct: boolean;
  suspensions: Array<{ name: string; tier: string; line: number | null }>;
  callsSuspendable: string[];
}

// ---- the module API (require("./transform.cjs")) — what the Vite plugin and CLI use ----
function configure(opts: CompileOptions = {}): void {
  AUTO_WRITEBACK = !!opts.autoWriteback;
  AUTO_DEREF = !!opts.autoDeref || AUTO_WRITEBACK;                // a write through a handle must first materialize it
  TRACK_WRITES = !!opts.trackWrites;
  SOURCE_MAP = !!opts.sourceMap;
  srcFile = opts.filename || "<tierless>";
  TIER_OF = { ...DEFAULT_RESOURCES, ...(opts.resources || {}) };
}

// compileModule(src, opts) -> { code, meta } where meta lists the compiled program names,
// which of them the source `export`ed (the actions surface), and the pure passthroughs.
function compileModule(src: string, opts: CompileOptions = {}): { code: string; meta: CompileMeta } {
  configure(opts);
  return compile(stripIfTs(src, opts.filename), opts.preamble || "");
}

// analyze(src, opts) -> per-function suspendability report (what `tierless explain` prints):
// is it compiled, why (direct resource touches / transitive calls), and every suspension point.
function analyze(src: string, opts: CompileOptions = {}): { functions: FunctionReport[]; resources: Record<string, string> } {
  configure(opts);
  const ast = parser.parse(stripIfTs(src, opts.filename), { sourceType: "module" }) as unknown as t.File;
  allowlist(ast);
  checkNestedSuspensions(ast);   // `explain` must reject exactly what `build` rejects — a tier call in a callback is un-compilable, not a compilable machine
  const { fnPaths, susp, directly, calls } = collectProgram(ast);
  const functions: FunctionReport[] = [];
  for (const [name, { p, exported }] of fnPaths) {
    const suspensions: FunctionReport["suspensions"] = [];
    p!.traverse({ YieldExpression(y) {
      if (!isResYield(y.node)) return;
      const a = (y.node.argument as t.CallExpression).arguments;
      suspensions.push({ name: (a[1] as t.StringLiteral).value, tier: (a[0] as t.StringLiteral).value, line: y.node.loc ? y.node.loc.start.line : null });
    } });
    const via = [...calls.get(name)!].filter((c) => susp.has(c));
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

export = { compile: compileModule, analyze, DEFAULT_RESOURCES };

// ---- CLI ----
function cliMain() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const [inPath, outPath] = args.filter((a) => !a.startsWith("--"));
  if (!inPath || !outPath) { console.error("usage: node transform.cjs <in.js> <out.gen.mjs> [--bare] [--head=<file>] [--auto-deref] [--auto-writeback] [--track-writes] [--source-map] [--resource=ns:tier ...]"); process.exit(2); }
  const resources: Record<string, string> = {};                    // --resource=db:server adds to the defaults
  for (const f of flags) if (f.startsWith("--resource=")) { const [ns, tier] = f.slice("--resource=".length).split(":"); if (!ns || !tier) { console.error("bad --resource (want ns:tier): " + f); process.exit(2); } resources[ns] = tier; }
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
  } catch (e) { console.error((e as Error).message); process.exit(2); }   // un-compilable input (e.g. a tier call in a callback) — print the clear message, not a V8 stack
}
if (require.main === module) cliMain();
