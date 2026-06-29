// Stackmix tier-splitting compiler (proof of concept).
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
// Control flow covered: sequence, if/else, while/for, break/continue, return, throw,
// try/catch/finally, and cross-function calls/returns. Lowered the way
// @babel/plugin-transform-regenerator lowers generators, but onto an explicit
// serializable frame instead of closure variables (which is what makes snapshot/restore
// possible). Known gaps (the compiler throws a clear error rather than miscompile):
// break/continue/return that EXITS a try, a suspendable call used as a sub-expression
// (assign it to a local first), switch, and labeled loops.
//
// Needs the Babel toolchain to RUN (not a repo dependency, like emscripten for
// qjs-migrate). The committed *.gen.mjs files are its output, so the demos run without
// it. To regenerate:
//   npm i -D @babel/parser@8 @babel/traverse@8 @babel/generator@8 @babel/types@8
//   node transform.cjs app/App.src.js app/bundle.gen.mjs
//   node transform.cjs cf-fixtures.src.js cf-fixtures.gen.mjs --bare
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default || require("@babel/traverse");
const generate = require("@babel/generator").default || require("@babel/generator");
const t = require("@babel/types");
const fs = require("fs");
const gen = (n) => generate(n, { concise: true }).code;

// ---- PASS 1: allow-list rewrite. Calls to tier-pinned namespaces become yields. ----
const TIER_OF = { api: "server", commit: "browser" }; // allow-list: which calls are tier-pinned
function allowlist(ast) {
  traverse(ast, { CallExpression(p) {
    const c = p.node.callee;
    let tier = null, name = null;
    const args = p.node.arguments;
    if (t.isMemberExpression(c) && t.isIdentifier(c.object) && TIER_OF[c.object.name] && t.isIdentifier(c.property)) {
      tier = TIER_OF[c.object.name]; name = c.object.name + "." + c.property.name;     // api.getTasks(...)
    } else if (t.isIdentifier(c) && TIER_OF[c.name]) {
      tier = TIER_OF[c.name]; name = "dom." + c.name;                                   // commit(...)
    } else if (t.isIdentifier(c) && c.name === "deref") {
      tier = "@deref"; name = "deref";                                                  // deref(handle): fetch from the handle's owner
    }
    if (!tier) return;
    p.replaceWith(t.yieldExpression(t.callExpression(t.identifier("R"),
      [t.stringLiteral(tier), t.stringLiteral(name), ...args])));
    // no p.skip(): keep traversing so nested tier calls in the args (e.g. api.f(api.g())) get rewritten too
  } });
}

// ---- PASS 2: state machine. Compile a suspendable function's body into basic blocks.
// ctx threads the targets break/continue/return jump to (brk/cont per loop, labels for
// labeled loops) plus tryStack — the enclosing trys — so an abrupt exit pops the right
// handlers and refuses to silently skip a finally.
let blocks, suspSet, AUTO_DEREF = false, AUTO_WRITEBACK = false, TRACK_WRITES = false;
const nb = () => (blocks.push({ lines: [], term: null }), blocks.length - 1);
const isSusp = (s) =>
  (t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isYieldExpression(s.declarations[0].init)) ||
  (t.isExpressionStatement(s) && t.isYieldExpression(s.expression));
function suspInfo(s) {
  const y = t.isVariableDeclaration(s) ? s.declarations[0].init : s.expression;
  const assign = t.isVariableDeclaration(s) ? s.declarations[0].id.name : null;
  const a = y.argument.arguments;                                  // R(tier, name, ...args)
  return { assign, op: `{ op: "resource", tier: ${gen(a[0])}, name: ${gen(a[1])}, args: [${a.slice(2).map(gen).join(", ")}] }` };
}
// a statement that calls another suspendable (compiled) function -> push a sub-frame
function callSusp(s) {
  let call = null, assign = null;
  if (t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isCallExpression(s.declarations[0].init)) { call = s.declarations[0].init; assign = s.declarations[0].id.name; }
  else if (t.isExpressionStatement(s) && t.isCallExpression(s.expression)) call = s.expression;
  if (call && t.isIdentifier(call.callee) && suspSet.has(call.callee.name)) return { assign, fn: call.callee.name, args: call.arguments.map(gen).join(", ") };
  return null;
}
function containsSuspCall(node) {                                  // a suspendable call buried in a sub-expression (rejected)
  let found = false;
  (function walk(n) {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "CallExpression" && n.callee && n.callee.type === "Identifier" && suspSet.has(n.callee.name)) { found = true; return; }
    for (const k in n) { if (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments") continue; walk(n[k]); }
  })(node);
  return found;
}

// ---- ANF normalization: hoist suspensions out of expression positions ----
// A suspension is a tier resource yield (R(...)) or a call to a suspendable function.
// After this pass every suspension is `const __tN = <susp>;` or `<susp>;` — a statement,
// which is all compileStmt knows how to lower. This is what lets ordinary code compile:
// `return f(x)`, `out = api.get()`, `a + f(x)`, `g(f(x))`, `if (api.check())`, `while (...)`.
const isResYield = (n) => t.isYieldExpression(n) && t.isCallExpression(n.argument) && t.isIdentifier(n.argument.callee, { name: "R" });
const isSuspCallNode = (n) => t.isCallExpression(n) && t.isIdentifier(n.callee) && suspSet.has(n.callee.name);
const isSuspExpr = (n) => isResYield(n) || isSuspCallNode(n);
function hasSuspInside(node, exclSelf) {
  let found = false;
  (function walk(n, root) {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, false));
    if (!(root && exclSelf) && isSuspExpr(n)) { found = true; return; }
    for (const k in n) { if (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments") continue; walk(n[k], false); }
  })(node, true);
  return found;
}
const isHeadNormal = (path) => {                                   // already in a position compileStmt handles
  const p = path.parentPath;
  if (p.isExpressionStatement()) return true;
  if (p.isVariableDeclarator() && p.node.init === path.node) { const d = p.parentPath; return d.node.declarations.length === 1 && (d.parentPath.isBlockStatement() || d.parentPath.isProgram() || d.parentPath.isSwitchCase()); }
  return false;
};
function assertSafeContext(path, stmt) {                           // safety net: nothing should reach here in a conditional position after desugaring
  let cur = path;
  while (cur && cur !== stmt) {
    const par = cur.parentPath;
    if (par.isLogicalExpression() && par.node.right === cur.node) throw new Error("suspension in the right side of && / || / ?? is not supported");
    if (par.isConditionalExpression() && (par.node.consequent === cur.node || par.node.alternate === cur.node)) throw new Error("suspension in a branch of ?: is not supported");
    // optional chaining: the base (object/callee) is unconditional and may be hoisted; only the
    // conditional part — a computed access ?.[susp] or optional-call args ?.(susp) — is rejected.
    if (par.isOptionalMemberExpression() && par.node.property === cur.node) throw new Error("suspension in an optional computed access (?.[ ]) is not supported (lift it to a statement)");
    if (par.isOptionalCallExpression() && par.node.arguments.indexOf(cur.node) >= 0) throw new Error("suspension in optional-call arguments (?.()) is not supported (lift it to a statement)");
    cur = par;
  }
}
// && || ?? ?: that CONTAIN a suspension -> lift into a temp via if-statements, so only the
// taken branch's suspension evaluates. The branches/test then normalize like any statement.
function desugarCondLog(path, name) {
  const n = path.node, id = () => t.identifier(name), assign = (v) => t.expressionStatement(t.assignmentExpression("=", id(), v));
  const out = [];
  if (t.isConditionalExpression(n)) {
    out.push(t.variableDeclaration("let", [t.variableDeclarator(id())]));
    out.push(t.ifStatement(n.test, t.blockStatement([assign(n.consequent)]), t.blockStatement([assign(n.alternate)])));
  } else {                                                          // LogicalExpression
    out.push(t.variableDeclaration("let", [t.variableDeclarator(id(), n.left)]));
    const cond = n.operator === "&&" ? id() : n.operator === "||" ? t.unaryExpression("!", id()) : t.binaryExpression("==", id(), t.nullLiteral());
    out.push(t.ifStatement(cond, t.blockStatement([assign(n.right)])));
  }
  path.getStatementParent().insertBefore(out);
  path.replaceWith(id());
}
function normalize(fnPath) {
  let counter = 0;
  const fresh = () => "__t" + (counter++);
  // Wrap any non-block if-branch or loop body whose suspension will be HOISTED, so the hoisted
  // `const __t = <susp>` lands INSIDE the conditionally-executed branch — not before the if/loop,
  // where it would run unconditionally (e.g. `if (c) x = f();` must only call f when c). Else-if
  // chains (an IfStatement alternate) are left intact, and a BARE suspension statement (`else
  // api.f();` — already head-normal, no hoist) is left untouched, so Tasks-style code is unchanged.
  const willHoist = (n) => n && !t.isBlockStatement(n) && !t.isIfStatement(n) && hasSuspInside(n, false) && !(t.isExpressionStatement(n) && isSuspExpr(n.expression));
  const wrapSusp = (p, key) => { if (willHoist(p.node[key])) p.get(key).replaceWith(t.blockStatement([p.node[key]])); };
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
        const wbody = [t.ifStatement(t.identifier(fv), t.expressionStatement(t.assignmentExpression("=", t.identifier(fv), t.booleanLiteral(false))), node.update ? t.expressionStatement(node.update) : null)];
        if (node.test) wbody.push(t.ifStatement(t.unaryExpression("!", node.test), t.blockStatement([t.breakStatement()])));
        wbody.push(...body);
        const outer = [];
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
    fnPath.traverse({ enter(p) {                                   // desugar an OUTERMOST && / || / ?? / ?: that contains a suspension
      if (acted) return;
      const n = p.node;
      if (!(t.isConditionalExpression(n) || t.isLogicalExpression(n)) || !hasSuspInside(n, false)) return;
      desugarCondLog(p, fresh());
      acted = true; p.stop();
    } });
    if (acted) continue;
    fnPath.traverse({ enter(p) {                                   // hoist one innermost, non-head-normal suspension into a temp
      if (acted) return;
      const n = p.node;
      if (!isSuspExpr(n) || hasSuspInside(n, true) || isHeadNormal(p)) return;
      const stmt = p.getStatementParent();
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
const blockStmts = (n) => (t.isBlockStatement(n) ? n.body : [n]);
const withNext = (ctx, next) => ({ ...ctx, next });
function compileStmts(stmts, ctx) { let cont = ctx.next; for (let i = stmts.length - 1; i >= 0; i--) cont = compileStmt(stmts[i], withNext(ctx, cont)); return cont; }

// Register a loop/switch label so `break label` / `continue label` can find their targets.
const regLabel = (ctx, brk, brkDepth, cont, contDepth) => (ctx.label ? { ...ctx.labels, [ctx.label]: { brk, brkDepth, cont, contDepth } } : ctx.labels);

function compileStmt(s, ctx) {
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
    if (s.init) { if (t.isVariableDeclaration(s.init)) for (const d of s.init.declarations) { if (d.init) blocks[init].lines.push(`F.${d.id.name} = ${gen(d.init)};`); } else blocks[init].lines.push(`${gen(s.init)};`); }
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
    for (let i = s.cases.length - 1; i >= 0; i--) { if (s.cases[i].test === null) continue; const b = nb(); blocks[b].term = { kind: "branch", cond: `${disc} === ${gen(s.cases[i].test)}`, then: entries[i], else: dispatch }; dispatch = b; }
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
    return abruptExit(ctx, tg.brkDepth, { ctype: "break", targetRaw: tg.brk });   // pop crossed handlers / run crossed finallys
  }
  if (t.isContinueStatement(s)) {
    const tg = s.label ? ctx.labels[s.label.name] : { cont: ctx.cont, contDepth: ctx.contDepth };
    if (!tg || tg.cont == null) throw new Error("continue has no target");
    return abruptExit(ctx, tg.contDepth, { ctype: "continue", targetRaw: tg.cont });
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
function compileTry(s, ctx) {
  const { next, tryDepth } = ctx;
  if (s.handler && s.finalizer) return compileTry(t.tryStatement(t.blockStatement([t.tryStatement(s.block, s.handler, null)]), null, s.finalizer), ctx);
  // tryStack records, per enclosing try, whether it has a finally — so an abrupt exit
  // (return/break/continue) knows which handlers to pop and won't silently skip a finally.

  if (s.handler) {                                                 // pure try/catch
    const inner = { ...ctx, tryDepth: tryDepth + 1, tryStack: [...ctx.tryStack, { hasFinally: false }] };
    const entry = nb(), catchB = nb();
    const bodyEnd = nb(); blocks[bodyEnd].lines.push("F.__h.pop();"); blocks[bodyEnd].term = { kind: "jump", to: next };
    const body = compileStmts(blockStmts(s.block), { ...inner, next: bodyEnd });
    blocks[entry].term = { kind: "pushTry", catch: catchB, fin: null, to: body };
    const param = s.handler.param ? s.handler.param.name : null;
    if (param) blocks[catchB].lines.push(`F.${param} = F.__err;`);
    const catchEnd = nb(); blocks[catchEnd].lines.push("F.__h.pop();"); blocks[catchEnd].term = { kind: "jump", to: next };
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
  const crossed = ctx.tryStack.slice(targetDepth).reverse();      // innermost -> outermost
  const b = nb();
  if (!crossed.some((x) => x.hasFinally)) {                        // no finally crossed: just pop handlers and go
    for (let i = 0; i < crossed.length; i++) blocks[b].lines.push("F.__h.pop();");
    blocks[b].term = completion.ctype === "return" ? { kind: "ret", value: completion.value } : { kind: "jump", to: completion.targetRaw };
    return b;
  }
  blocks[b].term = { kind: "abrupt", ctype: completion.ctype, value: completion.value, targetRaw: completion.targetRaw, steps: crossed.map((x) => x.hasFinally ? { finRaw: x.finB } : { pop: 1 }) };
  return b;
}

function compileFn(node) {
  const fnName = node.id.name;
  blocks = [];
  const END = nb(); blocks[END].term = { kind: "ret", value: '"(end)"' };
  const entry = compileStmts(node.body.body, { next: END, brk: END, brkDepth: 0, cont: END, contDepth: 0, tryDepth: 0, tryStack: [], labels: {}, label: undefined });
  const boot = nb(); blocks[boot].term = { kind: "jump", to: entry };  // pc 0 -> entry
  const ids = [boot, ...Array.from(blocks.keys()).filter((i) => i !== boot)];
  const remap = new Map(ids.map((id, i) => [id, i]));
  const R = (id) => remap.get(id);
  const P = (id) => (id == null ? "null" : R(id));                     // remapped pc, or null for absent catch/finally
  const emitTerm = (tm) => {
    if (tm.kind === "jump") return `F.pc = ${R(tm.to)}; break;`;
    if (tm.kind === "susp") return `F.pc = ${R(tm.resume)}; return ${tm.op};`;
    if (tm.kind === "call") return `F.pc = ${R(tm.resume)}; return { op: "call", fn: ${JSON.stringify(tm.fn)}, args: [${tm.args}] };`;
    if (tm.kind === "branch") return `if (${tm.cond}) { F.pc = ${R(tm.then)}; } else { F.pc = ${R(tm.else)}; } break;`;
    if (tm.kind === "ret") return `return { op: "return", value: ${tm.value} };`;
    if (tm.kind === "throw") return `{ const __t = __dispatch(F, ${tm.value}); if (__t == null) return { op: "throw", value: ${tm.value} }; F.pc = __t; break; }`;
    if (tm.kind === "pushTry") return `(F.__h || (F.__h = [])).push({ catch: ${P(tm.catch)}, fin: ${P(tm.fin)}, state: 0 }); F.pc = ${R(tm.to)}; break;`;
    if (tm.kind === "finish") return `{ F.__h.pop(); const __c = F.__c; if (!__c) { F.pc = ${R(tm.after)}; break; } if (__c.type === "throw") { F.__c = null; const __t = __dispatch(F, __c.arg); if (__t == null) return { op: "throw", value: __c.arg }; F.pc = __t; break; } const __p = __unwindStep(F); if (__p != null) { F.pc = __p; break; } F.__c = null; if (__c.type === "return") return { op: "return", value: __c.value }; F.pc = __c.target; break; }`;
    if (tm.kind === "abrupt") {                                       // return/break/continue crossing a finally: record completion + drive its finally chain
      const steps = "[" + tm.steps.map((s) => s.pop !== undefined ? `{ pop: ${s.pop} }` : `{ fin: ${R(s.finRaw)} }`).join(", ") + "]";
      const rec = tm.ctype === "return" ? `{ type: "return", value: ${tm.value}, steps: ${steps} }` : `{ type: ${JSON.stringify(tm.ctype)}, target: ${R(tm.targetRaw)}, steps: ${steps} }`;
      const exec = tm.ctype === "return" ? "return { op: \"return\", value: __c.value };" : "F.pc = __c.target; break;";
      return `F.__c = ${rec}; { const __p = __unwindStep(F); if (__p != null) { F.pc = __p; break; } const __c = F.__c; F.__c = null; ${exec} }`;
    }
    throw new Error("bad terminator " + tm.kind);
  };
  const cases = ids.map((id) => { const blk = blocks[id]; const lines = blk.lines.slice(); lines.push(emitTerm(blk.term)); return `      case ${R(id)}:\n        ${lines.join("\n        ")}`; }).join("\n");
  return `  ${fnName}(F) {\n    while (true) switch (F.pc) {\n${cases}\n    }\n  }`;
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
  p.traverse({ VariableDeclarator(v) {                            // const L = yield R(tier, "api.*")
    const init = v.node.init;
    if (t.isYieldExpression(init) && t.isCallExpression(init.argument) && t.isIdentifier(init.argument.callee, { name: "R" })
      && t.isStringLiteral(init.argument.arguments[1]) && init.argument.arguments[1].value.startsWith("api.") && t.isIdentifier(v.node.id)) remotable.add(v.node.id.name);
  } });
  return remotable;
}

function insertDerefGuards(p) {
  const remotable = remotableLocals(p);
  if (!remotable.size) return;
  const guards = new Map();                                       // statement node -> Set of locals to guard before it
  p.traverse({ Identifier(ip) {
    const name = ip.node.name;
    if (!remotable.has(name) || !ip.isReferencedIdentifier()) return;   // reads only (not the binding / write target)
    const stmt = ip.getStatementParent();
    if (!stmt) return;
    if (!guards.has(stmt.node)) guards.set(stmt.node, { path: stmt, locals: new Set() });
    guards.get(stmt.node).locals.add(name);
  } });
  for (const { path, locals } of guards.values()) {
    const g = [...locals].map((L) => t.ifStatement(t.callExpression(t.identifier("isHandle"), [t.identifier(L)]),
      t.blockStatement([t.expressionStatement(t.assignmentExpression("=", t.identifier(L),
        t.yieldExpression(t.callExpression(t.identifier("R"), [t.stringLiteral("@deref"), t.stringLiteral("deref"), t.identifier(L)]))))])));
    path.insertBefore(g);
  }
}

// --auto-writeback: transparent write-back, the symmetric partner of --auto-deref. A member
// MUTATION through a remotable local (`L.x = …`, `L[i].y = …`, `L[i]++`) edits the snapshot
// fetched on this tier; that edit must propagate to the owning master. After each such
// statement emit `yield R("@writeback","writeback", L)`, which the runtime resolves with an
// optimistic version-checked CAS (heap.mjs writeBack). Whole-identifier rebinds (`L = …`,
// incl. the deref guard's own `L = deref(L)`) are NOT writes through the object, so they're
// left alone. The developer writes ordinary `L[i].x = v`.
function rootOfMember(node) {                                     // the base identifier a member chain hangs off
  let o = node;
  while (t.isMemberExpression(o)) o = o.object;
  return t.isIdentifier(o) ? o.name : null;
}
function insertWriteBacks(p) {
  const remotable = remotableLocals(p);
  if (!remotable.size) return;
  const backs = new Map();                                        // statement node -> { path, locals } to write back after it
  const note = (target, ip) => {                                  // target is the assignment/update LHS
    if (!t.isMemberExpression(target)) return;                    // only member mutations propagate (a rebind doesn't touch the object)
    const root = rootOfMember(target);
    if (!root || !remotable.has(root)) return;
    const stmt = ip.getStatementParent();
    if (!stmt) return;
    if (!backs.has(stmt.node)) backs.set(stmt.node, { path: stmt, locals: new Set() });
    backs.get(stmt.node).locals.add(root);
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
function localNamesOf(p) {                                        // params + declared locals + catch params
  const names = new Set(p.node.params.filter((x) => t.isIdentifier(x)).map((x) => x.name));
  p.traverse({ VariableDeclarator(v) { if (t.isIdentifier(v.node.id)) names.add(v.node.id.name); },
    CatchClause(c) { if (c.node.param && t.isIdentifier(c.node.param)) names.add(c.node.param.name); } });
  return names;
}
function wrapBase(memberPath) {                                   // member.object -> __dirty(member.object), once
  const objPath = memberPath.get("object");
  if (t.isCallExpression(objPath.node) && t.isIdentifier(objPath.node.callee, { name: "__dirty" })) return;
  objPath.replaceWith(t.callExpression(t.identifier("__dirty"), [objPath.node]));
  objPath.skip();                                                // don't descend into the wrapper just created
}
function insertDirtyBarriers(p) {
  const locals = localNamesOf(p);
  const rooted = (member) => { const r = rootOfMember(member); return !!r && locals.has(r); };   // a continuation root, not a global
  p.traverse({
    AssignmentExpression(ap) { const tgt = ap.node.left; if (t.isMemberExpression(tgt) && rooted(tgt)) wrapBase(ap.get("left")); },
    UpdateExpression(up) { const tgt = up.node.argument; if (t.isMemberExpression(tgt) && rooted(tgt)) wrapBase(up.get("argument")); },
    CallExpression(cp) { const c = cp.node.callee; if (t.isMemberExpression(c) && !c.computed && t.isIdentifier(c.property) && MUTATOR_METHODS.has(c.property.name) && rooted(c)) wrapBase(cp.get("callee")); },
  });
}
// Emitted into the bundle under --track-writes. The owner installs a sink (the delta session's dirty
// set) around stepping via __setDirtySink (which returns the prior sink for save/restore); with none
// installed __dirty is a no-op that just returns its argument, so an untracked driver runs identically
// and serialization is unaffected (no function ever lands on a frame).
const TRACK_PREAMBLE = `let __DSINK = null;
export const __setDirtySink = (fn) => { const prev = __DSINK; __DSINK = fn || null; return prev; };
const __dirty = (o) => { if (__DSINK !== null && o !== null && typeof o === "object") __DSINK(o); return o; };`;

function lower(p) {
  if (AUTO_DEREF) insertDerefGuards(p);                           // before normalize: the guard's `L = deref(L)` is a suspension to hoist
  if (AUTO_WRITEBACK) insertWriteBacks(p);                        // after the guards (so the write-back yield isn't itself deref-guarded)
  if (TRACK_WRITES) insertDirtyBarriers(p);                       // after writeback/deref — their analyses need the unwrapped mutation target
  normalize(p);                                                   // hoist suspensions out of expression positions first
  const node = p.node;
  const params = node.params.map((x) => x.name);
  const locals = new Set();
  p.traverse({ VariableDeclarator(v) { if (t.isIdentifier(v.node.id)) locals.add(v.node.id.name); } });
  p.traverse({ CatchClause(c) { if (c.node.param && t.isIdentifier(c.node.param)) locals.add(c.node.param.name); } });
  p.traverse({ CallExpression(cp) {                              // validate suspendable calls are statements
    const c = cp.node.callee;
    if (!(t.isIdentifier(c) && suspSet.has(c.name))) return;
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
    if (params.includes(name)) ip.replaceWith(t.memberExpression(t.memberExpression(t.identifier("F"), t.identifier("args")), t.numericLiteral(params.indexOf(name)), true));
    else ip.replaceWith(t.memberExpression(t.identifier("F"), t.identifier(name)));
    ip.skip();
  } });
  p.traverse({ VariableDeclaration(v) {
    if (isSusp(v.node) || callSusp(v.node)) return;               // leave suspensions for compileStmt
    if (t.isForStatement(v.parent) && v.parent.init === v.node) return;
    const assigns = v.node.declarations.filter((d) => d.init).map((d) => t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("F"), t.identifier(d.id.name)), d.init)));
    if (assigns.length) v.replaceWithMultiple(assigns); else v.remove();
  } });
  return compileFn(node);
}

function compile(src, preamble) {
  const ast = parser.parse(src, { sourceType: "module" });
  allowlist(ast);
  const fnPaths = new Map();
  traverse(ast, { FunctionDeclaration(p) { if (t.isProgram(p.parent)) fnPaths.set(p.node.id.name, p); } });
  // suspendability: directly contains a yield (tier resource), or transitively calls one that does
  const calls = new Map(); const directly = new Set();
  for (const [name, p] of fnPaths) {
    let y = false; const cs = new Set();
    p.traverse({ YieldExpression() { y = true; }, CallExpression(cp) { const c = cp.node.callee; if (t.isIdentifier(c) && fnPaths.has(c.name)) cs.add(c.name); } });
    if (y) directly.add(name); calls.set(name, cs);
  }
  suspSet = new Set(directly);
  for (let changed = true; changed;) { changed = false; for (const [name, cs] of calls) if (!suspSet.has(name) && [...cs].some((c) => suspSet.has(c))) { suspSet.add(name); changed = true; } }

  const pure = [], progs = [];
  for (const [name, p] of fnPaths) {                              // pure single-tier fns run wholesale (lower() handles suspendable ones)
    if (suspSet.has(name)) { progs.push(lower(p)); }
    else { if (TRACK_WRITES) insertDirtyBarriers(p); pure.push(gen(p.node)); }  // a pure helper can still mutate continuation state
  }
  const head = preamble + (TRACK_WRITES ? "\n" + TRACK_PREAMBLE : "");
  return head + "\n" + (pure.length ? pure.join("\n") + "\n" : "") + "export const PROGRAMS = {\n" + progs.join(",\n") + "\n};\n" + DRIVER;
}

const DRIVER = `
// A §5 handle — a big local that stayed on its owning tier (see ../heap.mjs). With
// --auto-deref the machine guards reads of remotable locals with this check.
export const isHandle = (x) => x !== null && typeof x === "object" && x.__stackmix_handle__ === true;
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

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const [inPath, outPath] = args.filter((a) => !a.startsWith("--"));
if (!inPath || !outPath) { console.error("usage: node transform.cjs <in.js> <out.gen.mjs> [--bare] [--head=<file>] [--auto-deref] [--auto-writeback] [--track-writes]"); process.exit(2); }
AUTO_WRITEBACK = flags.includes("--auto-writeback");
AUTO_DEREF = flags.includes("--auto-deref") || AUTO_WRITEBACK;   // a write through a handle must first materialize it (deref)
TRACK_WRITES = flags.includes("--track-writes");                 // emit __dirty(obj) write-barriers for the delta wire's tracked mode
// The pure helpers an app's suspendable functions call (h/render/components) live in their own
// modules; the generated bundle imports them. --head=<file> supplies those import lines for a given
// app (so a second app can name its own components); the default is the Tasks app's.
const headFlag = flags.find((f) => f.startsWith("--head="));
const preamble = flags.includes("--bare") ? ""
  : headFlag ? fs.readFileSync(headFlag.slice("--head=".length), "utf8").trimEnd()
    : 'import { h } from "./h.mjs";\nimport { Dashboard } from "./components.mjs";\nimport { render } from "./render.mjs";';
fs.writeFileSync(outPath, "// GENERATED by transform.cjs from " + inPath + " — do not edit by hand.\n" + compile(fs.readFileSync(inPath, "utf8"), preamble));
console.log("wrote " + outPath);
