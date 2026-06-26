// Stackmix tier-splitting compiler (proof of concept).
//
// Input:  a plain function (e.g. app/App.src.js) written as if everything ran in one
//         place — straight-line calls to api.* and commit(), ordinary control flow.
// Output: a SERIALIZABLE state machine whose every suspension point is a tier-pinned
//         resource request. Nothing in the app is hand-written as a state machine;
//         this file generates it.
//
// Two passes:
//   PASS 1  allow-list rewrite. Calls into tier-pinned namespaces become yields that
//           name the owning tier. `api.*` -> server, `commit()` -> browser (TIER_OF).
//   PASS 2  CPS / state-machine lowering. The body is split at each yield into basic
//           blocks emitted as `case N:` of a `while(true) switch(F.pc)`. Locals and
//           params are hoisted onto the explicit frame object F (F.filter, F.ev, …) so
//           the whole continuation is plain serializable data — no closure, no native
//           stack — and can migrate between tiers mid-function.
//
// Control flow covered: sequence, if/else, while(true), while(cond), for(;;),
// break/continue, return, throw, and try/catch / try/finally / try/catch/finally —
// INCLUDING a resource error thrown across a suspend being caught by an enclosing
// catch, with the handler stack (F.__h) riding along in the serialized continuation.
// Lowered the way @babel/plugin-transform-regenerator lowers generators, but onto an
// explicit serializable frame instead of closure variables (which is what makes
// snapshot/restore possible). Known gaps: break/continue/return that EXIT a try (the
// compiler throws a clear error rather than miscompile), and suspensions inside nested
// function calls (no sub-frame yet).
//
// Needs the Babel toolchain to RUN (not a repo dependency, like emscripten for
// qjs-migrate). The committed app/bundle.gen.mjs is its output, so the demo runs
// without it. To regenerate:
//   npm i -D @babel/parser@8 @babel/traverse@8 @babel/generator@8 @babel/types@8
//   node transform.cjs app/App.src.js app/bundle.gen.mjs
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
    p.skip();
  } });
}

// ---- PASS 2: state machine. Compile the body into basic blocks. ----
// ctx threads { next, brk, cont, tryDepth, loopDepth } so break/continue know their
// target and we can reject a jump that would skip a try's handler bookkeeping.
let blocks;
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
const blockStmts = (n) => (t.isBlockStatement(n) ? n.body : [n]);
const withNext = (ctx, next) => ({ ...ctx, next });

function compileStmts(stmts, ctx) {
  let cont = ctx.next;
  for (let i = stmts.length - 1; i >= 0; i--) cont = compileStmt(stmts[i], withNext(ctx, cont));
  return cont;
}

function compileStmt(s, ctx) {
  const { next, brk, cont, tryDepth, loopDepth } = ctx;

  if (isSusp(s)) {
    const { assign, op } = suspInfo(s);
    const r = nb(); if (assign) blocks[r].lines.push(`F.${assign} = F.ret;`); blocks[r].term = { kind: "jump", to: next };
    const b = nb(); blocks[b].term = { kind: "susp", op, resume: r }; return b;     // resume binds F.<assign> = F.ret on success
  }
  if (t.isBlockStatement(s)) return compileStmts(s.body, ctx);

  if (t.isWhileStatement(s)) {
    const loop = { ...ctx, loopDepth: tryDepth };
    if (t.isBooleanLiteral(s.test, { value: true })) {                              // while(true): plain head, no test
      const head = nb(); const body = compileStmts(blockStmts(s.body), { ...loop, next: head, brk: next, cont: head });
      blocks[head].term = { kind: "jump", to: body }; return head;
    }
    const head = nb();
    const body = compileStmts(blockStmts(s.body), { ...loop, next: head, brk: next, cont: head });
    blocks[head].term = { kind: "branch", cond: gen(s.test), then: body, else: next }; return head;
  }

  if (t.isForStatement(s)) {
    const loop = { ...ctx, loopDepth: tryDepth };
    const init = nb();
    if (s.init) {
      if (t.isVariableDeclaration(s.init)) for (const d of s.init.declarations) { if (d.init) blocks[init].lines.push(`F.${d.id.name} = ${gen(d.init)};`); }
      else blocks[init].lines.push(`${gen(s.init)};`);
    }
    const head = nb();
    const update = nb(); if (s.update) blocks[update].lines.push(`${gen(s.update)};`);
    const body = compileStmts(blockStmts(s.body), { ...loop, next: update, brk: next, cont: update }); // continue -> update
    blocks[init].term = { kind: "jump", to: head };
    blocks[head].term = s.test ? { kind: "branch", cond: gen(s.test), then: body, else: next } : { kind: "jump", to: body };
    blocks[update].term = { kind: "jump", to: head };
    return init;
  }

  if (t.isIfStatement(s)) {
    const consequent = compileStmts(blockStmts(s.consequent), ctx);
    const alt = s.alternate ? compileStmts(blockStmts(s.alternate), ctx) : next;
    const b = nb(); blocks[b].term = { kind: "branch", cond: gen(s.test), then: consequent, else: alt }; return b;
  }

  if (t.isBreakStatement(s)) {
    if (tryDepth > loopDepth) throw new Error("break that exits a try is not yet supported");
    const b = nb(); blocks[b].term = { kind: "jump", to: brk }; return b;
  }
  if (t.isContinueStatement(s)) {
    if (tryDepth > loopDepth) throw new Error("continue that exits a try is not yet supported");
    const b = nb(); blocks[b].term = { kind: "jump", to: cont }; return b;
  }
  if (t.isReturnStatement(s)) {
    if (tryDepth > 0) throw new Error("return inside a try is not yet supported");
    const b = nb(); blocks[b].term = { kind: "ret", value: s.argument ? gen(s.argument) : "undefined" }; return b;
  }
  if (t.isThrowStatement(s)) { const b = nb(); blocks[b].term = { kind: "throw", value: gen(s.argument) }; return b; }

  if (t.isTryStatement(s)) return compileTry(s, ctx);

  const b = nb(); blocks[b].lines.push(gen(s)); blocks[b].term = { kind: "jump", to: next }; return b; // gen() of a statement already ends in ;
}

// try/catch/finally. catch+finally desugars to nested try/finally(try/catch) so only the
// two pure forms are lowered. Handlers live on the serializable stack F.__h, so a suspend
// inside a try survives migration with its catch/finally target intact.
function compileTry(s, ctx) {
  const { next, tryDepth } = ctx;
  if (s.handler && s.finalizer) {                                  // try B catch C finally F  ≡  try { try B catch C } finally F
    const inner = t.tryStatement(s.block, s.handler, null);
    return compileTry(t.tryStatement(t.blockStatement([inner]), null, s.finalizer), ctx);
  }
  const inner = { ...ctx, tryDepth: tryDepth + 1 };

  if (s.handler) {                                                 // pure try/catch
    const entry = nb(), catchB = nb();
    const bodyEnd = nb(); blocks[bodyEnd].lines.push("F.__h.pop();"); blocks[bodyEnd].term = { kind: "jump", to: next };
    const body = compileStmts(blockStmts(s.block), { ...inner, next: bodyEnd });
    blocks[entry].term = { kind: "pushTry", catch: catchB, fin: null, to: body };
    const param = s.handler.param ? s.handler.param.name : null;
    if (param) blocks[catchB].lines.push(`F.${param} = F.__err;`);
    const catchEnd = nb(); blocks[catchEnd].lines.push("F.__h.pop();"); blocks[catchEnd].term = { kind: "jump", to: next };
    blocks[catchB].term = { kind: "jump", to: compileStmts(blockStmts(s.handler.body), { ...ctx, next: catchEnd }) };
    return entry;
  }

  // pure try/finally
  const entry = nb(), finB = nb();
  const bodyEnd = nb();
  blocks[bodyEnd].lines.push("F.__h[F.__h.length - 1].state = 2;", "F.__c = null;");
  blocks[bodyEnd].term = { kind: "jump", to: finB };
  const body = compileStmts(blockStmts(s.block), { ...inner, next: bodyEnd });
  blocks[entry].term = { kind: "pushTry", catch: null, fin: finB, to: body };
  const finEnd = nb();
  blocks[finB].term = { kind: "jump", to: compileStmts(blockStmts(s.finalizer), { ...ctx, next: finEnd }) };
  blocks[finEnd].term = { kind: "finish", after: next };
  return entry;
}

function compileFn(node) {
  const fnName = node.id.name;
  blocks = [];
  const END = nb(); blocks[END].term = { kind: "ret", value: '"(end)"' };
  const entry = compileStmts(node.body.body, { next: END, brk: END, cont: END, tryDepth: 0, loopDepth: 0 });
  const boot = nb(); blocks[boot].term = { kind: "jump", to: entry };  // pc 0 -> entry
  const ids = [boot, ...Array.from(blocks.keys()).filter((i) => i !== boot)];
  const remap = new Map(ids.map((id, i) => [id, i]));
  const R = (id) => remap.get(id);
  const P = (id) => (id == null ? "null" : R(id));                     // remapped pc, or null for absent catch/finally
  const emitTerm = (tm) => {
    if (tm.kind === "jump") return `F.pc = ${R(tm.to)}; break;`;
    if (tm.kind === "susp") return `F.pc = ${R(tm.resume)}; return ${tm.op};`;
    if (tm.kind === "branch") return `if (${tm.cond}) { F.pc = ${R(tm.then)}; } else { F.pc = ${R(tm.else)}; } break;`;
    if (tm.kind === "ret") return `return { op: "return", value: ${tm.value} };`;
    if (tm.kind === "throw") return `{ const __t = __dispatch(F, ${tm.value}); if (__t == null) return { op: "throw", value: ${tm.value} }; F.pc = __t; break; }`;
    if (tm.kind === "pushTry") return `(F.__h || (F.__h = [])).push({ catch: ${P(tm.catch)}, fin: ${P(tm.fin)}, state: 0 }); F.pc = ${R(tm.to)}; break;`;
    if (tm.kind === "finish") return `{ const __c = F.__c; F.__c = null; F.__h.pop(); if (__c && __c.type === "throw") { const __t = __dispatch(F, __c.arg); if (__t == null) return { op: "throw", value: __c.arg }; F.pc = __t; break; } F.pc = ${R(tm.after)}; break; }`;
    throw new Error("bad terminator " + tm.kind);
  };
  const cases = ids.map((id) => {
    const blk = blocks[id]; const lines = blk.lines.slice();
    lines.push(emitTerm(blk.term));
    return `      case ${R(id)}:\n        ${lines.join("\n        ")}`;
  }).join("\n");
  return `  ${fnName}(F) {\n    while (true) switch (F.pc) {\n${cases}\n    }\n  }`;
}

function compile(src, preamble) {
  const ast = parser.parse(src, { sourceType: "module" });
  allowlist(ast);
  const progs = [];
  traverse(ast, { FunctionDeclaration(p) {
    const node = p.node;
    const params = node.params.map((x) => x.name);
    const locals = new Set();
    p.traverse({ VariableDeclarator(v) { if (t.isIdentifier(v.node.id)) locals.add(v.node.id.name); } });
    p.traverse({ CatchClause(c) { if (c.node.param && t.isIdentifier(c.node.param)) locals.add(c.node.param.name); } });
    // rewrite local + param refs -> F.x (reads and writes), skipping keys/decl-ids/catch-params/nested-fn params
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
    // var/let/const decls -> F.x = init assignments (the state machine owns the frame)
    p.traverse({ VariableDeclaration(v) {
      if (isSusp(v.node)) return;
      if (t.isForStatement(v.parent) && v.parent.init === v.node) return;   // for-init handled by compileStmt
      const assigns = v.node.declarations.filter((d) => d.init).map((d) => t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("F"), t.identifier(d.id.name)), d.init)));
      if (assigns.length) v.replaceWithMultiple(assigns); else v.remove();
    } });
    progs.push(compileFn(node));
  } });
  return preamble + "\nexport const PROGRAMS = {\n" + progs.join(",\n") + "\n};\n" + DRIVER;
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
// Single-tier driver: step the machine, stopping at every resource request. The two-tier
// runtime (../runtime.mjs) drives PROGRAMS directly and only stops at resources THIS tier
// doesn't own; this local driver keeps the bundle runnable alone.
export function run(stack) {
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "throw") throw r.value;
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
