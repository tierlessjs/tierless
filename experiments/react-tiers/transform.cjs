// Stackmix tier-splitting compiler (proof of concept).
//
// Input:  a plain function (app/App.src.js) written as if everything ran in one
//         place — straight-line calls to api.* and commit(), an ordinary while/if.
// Output: app/bundle.gen.mjs — that same function as a SERIALIZABLE state machine
//         whose every suspension point is a tier-pinned resource request. Nothing in
//         the app is hand-written as a state machine; this file generates it.
//
// Two passes:
//   PASS 1  allow-list rewrite. Calls into tier-pinned namespaces become yields that
//           name the owning tier. `api.*` is pinned to the server, `commit()` to the
//           browser (TIER_OF). api.getTasks({status}) -> yield R("server","api.getTasks",{status}).
//   PASS 2  CPS / state-machine lowering. The body is split at each yield into basic
//           blocks emitted as `case N:` of a `while(true) switch(F.pc)`. Locals and
//           params are hoisted onto the explicit frame object F (F.filter, F.ev, …) so
//           the whole continuation is plain serializable data — no closure, no native
//           stack — and can migrate between tiers mid-function.
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

// ---- PASS 2: state machine. Compile body (seq / while(true) / if-else / break) ----
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
function compileStmts(stmts, next, brk) { let cont = next; for (let i = stmts.length - 1; i >= 0; i--) cont = compileStmt(stmts[i], cont, brk); return cont; }
function compileStmt(s, next, brk) {
  if (isSusp(s)) {
    const { assign, op } = suspInfo(s);
    const r = nb(); if (assign) blocks[r].lines.push(`F.${assign} = F.ret;`); blocks[r].term = { kind: "jump", to: next };
    const b = nb(); blocks[b].term = { kind: "susp", op, resume: r }; return b;
  }
  if (t.isWhileStatement(s) && t.isBooleanLiteral(s.test, { value: true })) {
    const loop = nb(); const body = compileStmts(s.body.body, loop, next); blocks[loop].term = { kind: "jump", to: body }; return loop;
  }
  if (t.isIfStatement(s)) {
    const cons = compileStmts(blockStmts(s.consequent), next, brk);
    const alt = s.alternate ? compileStmts(blockStmts(s.alternate), next, brk) : next;
    const b = nb(); blocks[b].term = { kind: "branch", cond: gen(s.test), then: cons, else: alt }; return b;
  }
  if (t.isBreakStatement(s)) { const b = nb(); blocks[b].term = { kind: "jump", to: brk }; return b; }
  if (t.isReturnStatement(s)) { const b = nb(); blocks[b].term = { kind: "ret", value: s.argument ? gen(s.argument) : "undefined" }; return b; }
  const b = nb(); blocks[b].lines.push(gen(s)); blocks[b].term = { kind: "jump", to: next }; return b;
}

function compileFn(node) {
  const fnName = node.id.name;
  blocks = [];
  const END = nb(); blocks[END].term = { kind: "ret", value: '"(end)"' };
  const entry = compileStmts(node.body.body, END, END);
  const boot = nb(); blocks[boot].term = { kind: "jump", to: entry };  // pc 0 -> entry
  // renumber so boot = 0
  const ids = [boot, ...Array.from(blocks.keys()).filter((i) => i !== boot)];
  const remap = new Map(ids.map((id, i) => [id, i]));
  const R = (id) => remap.get(id);
  const cases = ids.map((id) => {
    const blk = blocks[id]; const lines = blk.lines.slice(); const tm = blk.term;
    if (tm.kind === "jump") lines.push(`F.pc = ${R(tm.to)}; break;`);
    else if (tm.kind === "susp") lines.push(`F.pc = ${R(tm.resume)}; return ${tm.op};`);
    else if (tm.kind === "branch") lines.push(`if (${tm.cond}) { F.pc = ${R(tm.then)}; } else { F.pc = ${R(tm.else)}; } break;`);
    else if (tm.kind === "ret") lines.push(`return { op: "return", value: ${tm.value} };`);
    return `      case ${R(id)}:\n        ${lines.join("\n        ")}`;
  }).join("\n");
  return { fnName, code: `  ${fnName}(F) {\n    while (true) switch (F.pc) {\n${cases}\n    }\n  }` };
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
    // rewrite local + param refs -> F.x (reads and writes), skipping keys/decl-ids/nested-fn params
    p.traverse({ Identifier(ip) {
      const name = ip.node.name;
      if (name === "F" || !(params.includes(name) || locals.has(name))) return;
      const par = ip.parent;
      if (t.isMemberExpression(par) && par.property === ip.node && !par.computed) return;
      if (t.isObjectProperty(par) && par.key === ip.node && !par.computed) return;
      if (t.isVariableDeclarator(par) && par.id === ip.node) return;
      if (t.isFunction(par)) return;
      if (params.includes(name)) ip.replaceWith(t.memberExpression(t.memberExpression(t.identifier("F"), t.identifier("args")), t.numericLiteral(params.indexOf(name)), true));
      else ip.replaceWith(t.memberExpression(t.identifier("F"), t.identifier(name)));
      ip.skip();
    } });
    // var/let/const decls -> F.x = init assignments (the state machine owns the frame)
    p.traverse({ VariableDeclaration(v) {
      if (isSusp(v.node)) return;
      const assigns = v.node.declarations.filter((d) => d.init).map((d) => t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("F"), t.identifier(d.id.name)), d.init)));
      if (assigns.length) v.replaceWithMultiple(assigns); else v.remove();
    } });
    progs.push(compileFn(node));
  } });
  return preamble + "\nexport const PROGRAMS = {\n" + progs.map((p) => p.code).join(",\n") + "\n};\n" + DRIVER;
}

const DRIVER = `
// Single-tier driver: step the machine, stopping at every resource request. The
// two-tier runtime (../runtime.mjs) drives PROGRAMS directly and only stops at
// resources THIS tier doesn't own; this local driver keeps the bundle runnable alone.
export function run(stack) {
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "resource") return { done: false, request: r, stack };
  }
}
export const start = (fn, args = []) => run([{ fn, pc: 0, args }]);
`;

const PREAMBLE = 'import { h } from "./h.mjs";\nimport { Dashboard } from "./components.mjs";\nimport { render } from "./render.mjs";';
const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error("usage: node transform.cjs <App.src.js> <bundle.gen.mjs>"); process.exit(2); }
const banner = "// GENERATED by transform.cjs from " + inPath + " — do not edit by hand.\n";
fs.writeFileSync(outPath, banner + compile(fs.readFileSync(inPath, "utf8"), PREAMBLE));
console.log("wrote " + outPath);
