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
let blocks, suspSet;
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
    if (par.isOptionalMemberExpression() || par.isOptionalCallExpression()) throw new Error("suspension under optional chaining (?.) is not supported");
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
  for (let guard = 0; guard < 100000; guard++) {
    let acted = false;
    fnPath.traverse({ WhileStatement(p) {                         // while(E) where E suspends -> while(true){ if(!(E)) break; body }
      if (acted || t.isBooleanLiteral(p.node.test, { value: true }) || !hasSuspInside(p.node.test, false)) return;
      const body = t.isBlockStatement(p.node.body) ? p.node.body.body : [p.node.body];
      p.replaceWith(t.whileStatement(t.booleanLiteral(true), t.blockStatement([t.ifStatement(t.unaryExpression("!", p.node.test), t.blockStatement([t.breakStatement()])), ...body])));
      acted = true; p.stop();
    } });
    if (acted) continue;
    fnPath.traverse({ ForStatement(p) {                           // for(init;test;update): move a suspending test into the body; hoist a suspending init
      if (acted) return;
      const node = p.node;
      if (node.update && hasSuspInside(node.update, false)) throw new Error("suspension in a for-update is not supported (do it inside the body)");
      if (node.test && hasSuspInside(node.test, false)) {
        const body = t.isBlockStatement(node.body) ? node.body.body : [node.body];
        p.replaceWith(t.forStatement(node.init, null, node.update, t.blockStatement([t.ifStatement(t.unaryExpression("!", node.test), t.blockStatement([t.breakStatement()])), ...body])));
        acted = true; p.stop(); return;
      }
      if (node.init && hasSuspInside(node.init, false)) {          // init runs once -> a plain statement before the loop
        p.insertBefore(t.isVariableDeclaration(node.init) ? node.init : t.expressionStatement(node.init));
        node.init = null; acted = true; p.stop();
      }
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
    return abruptExit(ctx, tg.brkDepth, { kind: "jump", to: tg.brk });   // pop handlers of crossed trys
  }
  if (t.isContinueStatement(s)) {
    const tg = s.label ? ctx.labels[s.label.name] : { cont: ctx.cont, contDepth: ctx.contDepth };
    if (!tg || tg.cont == null) throw new Error("continue has no target");
    return abruptExit(ctx, tg.contDepth, { kind: "jump", to: tg.cont });
  }
  if (t.isReturnStatement(s)) {
    return abruptExit(ctx, 0, { kind: "ret", value: s.argument ? gen(s.argument) : "undefined" });
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
  const inner = { ...ctx, tryDepth: tryDepth + 1, tryStack: [...ctx.tryStack, { hasFinally: true }] };
  const entry = nb(), finB = nb();
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

// An abrupt exit (return/break/continue) that crosses enclosing trys must pop each one's
// handler. Crossing a try that has a finally is the deferred hard case (completion records).
function abruptExit(ctx, targetDepth, term) {
  const crossed = ctx.tryStack.slice(targetDepth);
  if (crossed.some((x) => x.hasFinally)) throw new Error("return/break/continue across a finally is not yet supported");
  const b = nb();
  for (let i = 0; i < crossed.length; i++) blocks[b].lines.push("F.__h.pop();");
  blocks[b].term = term;
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
    if (tm.kind === "finish") return `{ const __c = F.__c; F.__c = null; F.__h.pop(); if (__c && __c.type === "throw") { const __t = __dispatch(F, __c.arg); if (__t == null) return { op: "throw", value: __c.arg }; F.pc = __t; break; } F.pc = ${R(tm.after)}; break; }`;
    throw new Error("bad terminator " + tm.kind);
  };
  const cases = ids.map((id) => { const blk = blocks[id]; const lines = blk.lines.slice(); lines.push(emitTerm(blk.term)); return `      case ${R(id)}:\n        ${lines.join("\n        ")}`; }).join("\n");
  return `  ${fnName}(F) {\n    while (true) switch (F.pc) {\n${cases}\n    }\n  }`;
}

// Rewrite a suspendable function's locals/params -> F.x, then compile it to a machine.
function lower(p) {
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
  for (const [name, p] of fnPaths) { if (suspSet.has(name)) progs.push(lower(p)); else pure.push(gen(p.node)); }  // pure single-tier fns run wholesale
  return preamble + "\n" + (pure.length ? pure.join("\n") + "\n" : "") + "export const PROGRAMS = {\n" + progs.join(",\n") + "\n};\n" + DRIVER;
}

const DRIVER = `
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

const [, , inPath, outPath, mode] = process.argv;
if (!inPath || !outPath) { console.error("usage: node transform.cjs <in.js> <out.gen.mjs> [--bare]"); process.exit(2); }
const preamble = mode === "--bare" ? "" : 'import { h } from "./h.mjs";\nimport { Dashboard } from "./components.mjs";\nimport { render } from "./render.mjs";';
fs.writeFileSync(outPath, "// GENERATED by transform.cjs from " + inPath + " — do not edit by hand.\n" + compile(fs.readFileSync(inPath, "utf8"), preamble));
console.log("wrote " + outPath);
