// Waso — TypeScript -> JS-IR frontend (#4: closures + await + mutable captures).
//
// Targets the de-risked JS interpreter (waso-core). Lowers the hard parts of
// "real TS": first-class closures (closure conversion), `await` as a suspension,
// and — new here — MUTABLE CAPTURED VARIABLES. A variable that is both captured
// by a nested closure and assigned is "boxed": stored in a shared cell (a heap
// object {v}). All readers/writers go through the cell, so mutations are shared;
// and because the wire format preserves object identity, the sharing survives a
// migration (the cell is one node, referenced by every closure that captured it).
//
// We parse a subset with the TS compiler API; we do not typecheck.

import ts from "typescript";

const BINOP = {
  [ts.SyntaxKind.PlusToken]: "+", [ts.SyntaxKind.MinusToken]: "-", [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.LessThanToken]: "<", [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.GreaterThanToken]: ">", [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===", [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
};
const isFnLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);

// Decide which variable names need boxing: captured by a nested function AND
// assigned somewhere. (Names only; lexical shadowing is not modeled — a known
// subset limitation.)
function analyzeBoxing(sf) {
  const assigned = new Set(), captured = new Set();
  const declaredNames = (fn) => {
    const s = new Set();
    fn.parameters.forEach((p) => ts.isIdentifier(p.name) && s.add(p.name.text));
    const collect = (n) => { if (isFnLike(n)) return; if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) s.add(n.name.text); ts.forEachChild(n, collect); };
    if (fn.body) collect(fn.body);
    return s;
  };
  const isPropName = (node) => {
    const p = node.parent;
    return p && ((ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node)
      || (ts.isParameter(p) && p.name === node) || (ts.isVariableDeclaration(p) && p.name === node) || (isFnLike(p) && p.name === node));
  };
  const isWrite = (node) => {
    const p = node.parent;
    if (!p) return false;
    if (ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
    if ((ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p)) && p.operand === node) return true;
    return false;
  };
  const scopes = [];
  const walk = (node) => {
    const fn = isFnLike(node);
    if (fn) scopes.push(declaredNames(node));
    if (ts.isIdentifier(node) && !isPropName(node)) {
      const name = node.text;
      if (isWrite(node)) assigned.add(name);
      let at = -1;
      for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) { at = i; break; }
      if (at >= 0 && at < scopes.length - 1) captured.add(name); // declared in an ANCESTOR function
    }
    ts.forEachChild(node, walk);
    if (fn) scopes.pop();
  };
  walk(sf);
  return new Set([...captured].filter((n) => assigned.has(n)));
}

export function compileModule(source, { resources = [], entry = "main" } = {}) {
  const sf = ts.createSourceFile("app.ts", source, ts.ScriptTarget.ES2020, true);
  const topFns = new Map();
  for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name) topFns.set(s.name.text, s);
  const resourceSet = new Set(resources);
  const boxed = analyzeBoxing(sf);
  const out = {};
  let gen = 0;

  const assemble = (list) => {
    const labels = {}, code = [];
    for (const l of list) (typeof l === "string") ? (labels[l] = code.length) : code.push(l);
    for (const ins of code) if ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string") ins[1] = labels[ins[1]];
    return code;
  };
  const compileTop = (name) => { if (name in out) return; out[name] = null; const c = compileFn(topFns.get(name), name); out[name] = { nlocals: c.nlocals, code: c.code }; };

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

    // Box captured params at entry: wrap the incoming value into a cell {v}.
    const entryBoxing = [];
    for (const p of node.parameters) if (boxed.has(p.name.text)) {
      const s = localIdx(p.name.text);
      entryBoxing.push(["NEWOBJ"], ["LOAD", s], ["SETPROP", "v"], ["STORE", s]);
    }

    // Emit a read of a variable (boxed -> through the cell's .v).
    function readName(n) {
      if (locals.has(n)) { emit("LOAD", locals.get(n)); if (boxed.has(n)) emit("GETPROP", "v"); return; }
      if (topFns.has(n)) { compileTop(n); emit("MAKECLOSURE", n, []); return; }
      const i = capture(n); emit("LOADENV", i); if (boxed.has(n)) emit("GETPROP", "v"); // free var
    }
    // Emit a write `name = <value already-emitting via valThunk>`.
    function writeName(n, valThunk) {
      if (boxed.has(n)) {                                   // store into the shared cell
        if (locals.has(n)) emit("LOAD", locals.get(n)); else emit("LOADENV", capture(n));
        valThunk(); emit("SETPROP", "v"); emit("POP");
        return;
      }
      valThunk(); emit("STORE", locals.has(n) ? locals.get(n) : localIdx(n)); // plain local
    }

    function closureOf(fnNode) {
      const childName = `${name}$${gen++}`;
      const child = compileFn(fnNode, childName);
      out[childName] = { nlocals: child.nlocals, code: child.code };
      const caps = child.freeVars.map((fv) => locals.has(fv) ? ["L", locals.get(fv)] : ["E", capture(fv)]);
      emit("MAKECLOSURE", childName, caps);
    }

    function expr(node) {                                   // returns true if it leaves one value
      if (ts.isParenthesizedExpression(node)) return expr(node.expression);
      if (ts.isNumericLiteral(node)) { emit("PUSH", Number(node.text)); return true; }
      if (ts.isStringLiteral(node)) { emit("PUSH", node.text); return true; }
      if (ts.isIdentifier(node)) { readName(node.text); return true; }
      if (ts.isAwaitExpression(node)) { expr(node.expression); emit("AWAIT"); return true; }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) { closureOf(node); return true; }
      if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        if (node.operator !== ts.SyntaxKind.PlusPlusToken && node.operator !== ts.SyntaxKind.MinusMinusToken) fail(node, "unsupported unary");
        const op = node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
        writeName(node.operand.text, () => { readName(node.operand.text); emit("PUSH", 1); emit("BIN", op); });
        return false;                                       // used as a statement / for-incrementor
      }
      if (ts.isBinaryExpression(node)) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          if (!ts.isIdentifier(node.left)) fail(node, "can only assign to a variable");
          writeName(node.left.text, () => expr(node.right));
          return false;
        }
        const op = BINOP[node.operatorToken.kind]; if (!op) fail(node, "unsupported operator");
        expr(node.left); expr(node.right); emit("BIN", op); return true;
      }
      if (ts.isPropertyAccessExpression(node)) { expr(node.expression); emit("GETPROP", node.name.text); return true; }
      if (ts.isElementAccessExpression(node)) { expr(node.expression); expr(node.argumentExpression); emit("INDEX"); return true; }
      if (ts.isObjectLiteralExpression(node)) {
        emit("NEWOBJ");
        for (const p of node.properties) {
          if (ts.isPropertyAssignment(p)) { expr(p.initializer); emit("SETPROP", p.name.text); }
          else if (ts.isShorthandPropertyAssignment(p)) { readName(p.name.text); emit("SETPROP", p.name.text); }
          else fail(p, "unsupported property");
        }
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
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "push") { expr(callee.expression); expr(node.arguments[0]); emit("ARRPUSH"); return false; }
      expr(callee); node.arguments.forEach(expr); emit("CALLV", node.arguments.length); return true; // closure or method (property holding a closure)
    }

    function stmt(node) {
      if (ts.isBlock(node)) return node.statements.forEach(stmt);
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (!d.initializer) fail(d, "needs initializer");
          const n = d.name.text;
          if (boxed.has(n)) { const s = localIdx(n); emit("NEWOBJ"); expr(d.initializer); emit("SETPROP", "v"); emit("STORE", s); } // cell {v: init}
          else { expr(d.initializer); emit("STORE", localIdx(n)); }
        }
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
    else { expr(node.body); emit("RET"); }
    const last = asm[asm.length - 1];
    if (!(Array.isArray(last) && last[0] === "RET")) { emit("PUSH", 0); emit("RET"); }
    return { nlocals: locals.size, code: assemble([...entryBoxing, ...asm]), freeVars: envNames };
  }

  compileTop(entry);
  return out;
}

export function loadModule(PROGRAM, source, opts) {
  const frag = compileModule(source, opts);
  for (const [k, v] of Object.entries(frag)) PROGRAM[k] = v;
  return frag;
}
