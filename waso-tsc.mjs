// Waso — TypeScript -> JS-IR frontend (#4, step 1: closures + await).
//
// Unlike the toy wasm-IR compiler (waso-compile.mjs), this targets the de-risked
// JS interpreter (waso-core) and lowers the genuinely hard things for "real TS":
//   - functions calling functions (CALLV over first-class closures)
//   - closures: an arrow/function expression captures its free variables; we do
//     closure conversion, emitting MAKECLOSURE with a capture spec and LOADENV
//     for captured reads. A top-level function reference is a closure with no
//     captures.
//   - `await expr` lowers to (expr; AWAIT) — async is just a suspension point,
//     so there are no colored functions: any function may suspend.
// Resource calls (a known namespace like `db.x(...)` or a bare `ext(...)`) lower
// to RES. We parse a subset with the TS compiler API; we do not typecheck.

import ts from "typescript";

const BINOP = {
  [ts.SyntaxKind.PlusToken]: "+", [ts.SyntaxKind.MinusToken]: "-", [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.LessThanToken]: "<", [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.GreaterThanToken]: ">", [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===", [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
};

export function compileModule(source, { resources = [], entry = "main" } = {}) {
  const sf = ts.createSourceFile("app.ts", source, ts.ScriptTarget.ES2020, true);
  const topFns = new Map();
  for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name) topFns.set(s.name.text, s);
  const resourceSet = new Set(resources);
  const out = {};       // PROGRAM fragment: fnName -> { nlocals, code }
  let gen = 0;

  function assemble(list) {
    const labels = {}, code = [];
    for (const l of list) (typeof l === "string") ? (labels[l] = code.length) : code.push(l);
    for (const ins of code) if ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string") ins[1] = labels[ins[1]];
    return code;
  }

  function compileTop(name) {
    if (name in out) return;
    out[name] = null; // reservation guard against recursion
    const c = compileFn(topFns.get(name), name);
    out[name] = { nlocals: c.nlocals, code: c.code };
  }

  function compileFn(node, name) {
    const locals = new Map();
    const localIdx = (n) => { if (!locals.has(n)) locals.set(n, locals.size); return locals.get(n); };
    for (const p of node.parameters) localIdx(p.name.text);
    const envIdx = new Map(); const envNames = [];
    const capture = (n) => { if (!envIdx.has(n)) { envIdx.set(n, envNames.length); envNames.push(n); } return envIdx.get(n); };

    const asm = []; let lab = 0;
    const emit = (...x) => asm.push(x);
    const mark = (l) => asm.push(l);
    const label = (s) => `${s}_${gen}_${lab++}`;
    const fail = (nd, m) => { throw new Error(`waso-tsc: ${m}: \`${nd.getText(sf)}\``); };

    function useName(n) {
      if (locals.has(n)) { emit("LOAD", locals.get(n)); return; }
      if (topFns.has(n)) { compileTop(n); emit("MAKECLOSURE", n, []); return; } // top-level fn ref = closure
      emit("LOADENV", capture(n)); // free variable -> captured from enclosing scope
    }

    function closureOf(fnNode) {
      const childName = `${name}$${gen++}`;
      const child = compileFn(fnNode, childName);
      out[childName] = { nlocals: child.nlocals, code: child.code };
      const caps = child.freeVars.map((fv) =>
        locals.has(fv) ? ["L", locals.get(fv)] : ["E", capture(fv)]);  // provide each free var from here
      emit("MAKECLOSURE", childName, caps);
    }

    // Returns true if the expression leaves exactly one value on the stack.
    function expr(node) {
      if (ts.isParenthesizedExpression(node)) return expr(node.expression);
      if (ts.isNumericLiteral(node)) { emit("PUSH", Number(node.text)); return true; }
      if (ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.FirstTemplateToken) { emit("PUSH", node.text); return true; }
      if (ts.isIdentifier(node)) { useName(node.text); return true; }
      if (ts.isAwaitExpression(node)) { if (!expr(node.expression)) fail(node, "await of nothing"); emit("AWAIT"); return true; }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) { closureOf(node); return true; }
      if (ts.isBinaryExpression(node)) {
        const op = BINOP[node.operatorToken.kind];
        if (!op) fail(node, "unsupported operator");
        expr(node.left); expr(node.right); emit("BIN", op); return true;
      }
      if (ts.isPropertyAccessExpression(node)) { expr(node.expression); emit("GETPROP", node.name.text); return true; }
      if (ts.isElementAccessExpression(node)) { expr(node.expression); expr(node.argumentExpression); emit("INDEX"); return true; }
      if (ts.isObjectLiteralExpression(node)) {
        emit("NEWOBJ");
        for (const p of node.properties) { if (!ts.isPropertyAssignment(p)) fail(p, "only simple properties"); expr(p.initializer); emit("SETPROP", p.name.text); }
        return true;
      }
      if (ts.isArrayLiteralExpression(node)) { if (node.elements.length) fail(node, "only empty array literals"); emit("NEWARR"); return true; }
      if (ts.isCallExpression(node)) return call(node);
      fail(node, "unsupported expression");
    }

    function call(node) {
      const callee = node.expression;
      const resName = ts.isPropertyAccessExpression(callee) ? `${callee.expression.getText(sf)}.${callee.name.text}`
        : ts.isIdentifier(callee) ? callee.text : null;
      if (resName && resourceSet.has(resName)) { node.arguments.forEach(expr); emit("RES", resName, node.arguments.length); return true; }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "push") { // arr.push(v)
        expr(callee.expression); if (node.arguments.length !== 1) fail(node, "push expects 1 arg"); expr(node.arguments[0]); emit("ARRPUSH"); return false;
      }
      expr(callee); node.arguments.forEach(expr); emit("CALLV", node.arguments.length); return true; // closure call
    }

    function stmt(node) {
      if (ts.isBlock(node)) return node.statements.forEach(stmt);
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) { if (!d.initializer) fail(d, "needs initializer"); expr(d.initializer); emit("STORE", localIdx(d.name.text)); }
        return;
      }
      if (ts.isExpressionStatement(node)) { if (expr(node.expression)) emit("POP"); return; }
      if (ts.isReturnStatement(node)) { if (!node.expression) emit("PUSH", 0); else expr(node.expression); emit("RET"); return; }
      if (ts.isIfStatement(node)) {
        expr(node.expression); const els = label("else"), end = label("end");
        emit("JMPF", node.elseStatement ? els : end); stmt(node.thenStatement);
        if (node.elseStatement) { emit("JMP", end); mark(els); stmt(node.elseStatement); } mark(end); return;
      }
      if (ts.isForStatement(node)) {
        if (node.initializer && ts.isVariableDeclarationList(node.initializer))
          for (const d of node.initializer.declarations) { expr(d.initializer); emit("STORE", localIdx(d.name.text)); }
        const loop = label("loop"), end = label("end"); mark(loop);
        if (node.condition) { expr(node.condition); emit("JMPF", end); }
        stmt(node.statement);
        if (node.incrementor) { if (expr(node.incrementor)) emit("POP"); }
        emit("JMP", loop); mark(end); return;
      }
      fail(node, "unsupported statement");
    }

    if (node.body && ts.isBlock(node.body)) node.body.statements.forEach(stmt);
    else { expr(node.body); emit("RET"); }                    // arrow with an expression body
    const last = asm[asm.length - 1];
    if (!(Array.isArray(last) && last[0] === "RET")) { emit("PUSH", 0); emit("RET"); }
    return { nlocals: locals.size, code: assemble(asm), freeVars: envNames };
  }

  compileTop(entry);
  return out;
}

// Register a compiled module into a PROGRAM object.
export function loadModule(PROGRAM, source, opts) {
  const frag = compileModule(source, opts);
  for (const [k, v] of Object.entries(frag)) PROGRAM[k] = v;
  return frag;
}
