// Waso — TypeScript -> JS-IR frontend (#4).
//
// Targets the de-risked JS interpreter (waso-core). Lowers the hard parts of
// "real TS":
//   - first-class closures (closure conversion) and `await` as a suspension;
//   - mutable captured variables, via boxing into a shared cell {v} so two
//     closures share a `let` and the sharing survives migration (the wire
//     format preserves object identity);
//   - binding-keyed scope resolution, so lexical SHADOWING is correct (two
//     different variables with the same name are distinct bindings);
//   - control flow: if/else, for, while, &&/||, ternary, break/continue,
//     assignment, ++/--, += -= *=.
// Every emitted instruction carries its TS source position (line/col/text), so
// a serialized continuation maps back to a TS-level stack trace.
//
// We parse a subset with the TS compiler API; we do not typecheck.

import ts from "typescript";

const BINOP = {
  [ts.SyntaxKind.PlusToken]: "+", [ts.SyntaxKind.MinusToken]: "-", [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.SlashToken]: "/", [ts.SyntaxKind.PercentToken]: "%",
  [ts.SyntaxKind.LessThanToken]: "<", [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.GreaterThanToken]: ">", [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===", [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
};
const COMPOUND = new Map([
  [ts.SyntaxKind.PlusEqualsToken, "+"], [ts.SyntaxKind.MinusEqualsToken, "-"], [ts.SyntaxKind.AsteriskEqualsToken, "*"],
]);
const isFnLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);

// --- scope resolution: assign every binding a unique id (handles shadowing) --
function resolveBindings(sf) {
  let next = 1;
  const bindingOf = new Map();      // identifier node (decl or use) -> binding id
  const declFn = new Map();         // id -> declaring function node
  const bindingsByFn = new Map();   // fn node -> [id] (params first, then locals)
  const captured = new Set(), assigned = new Set();

  const declNames = (fn) => {       // params first, then const/let in the body (function-scoped)
    const params = fn.parameters.map((p) => p.name).filter(ts.isIdentifier);
    const vars = [];
    const collect = (n) => { if (isFnLike(n)) return; if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) vars.push(n.name); ts.forEachChild(n, collect); };
    if (fn.body) collect(fn.body);
    return [...params, ...vars];
  };
  const isPropName = (node) => { const p = node.parent; return p && ((ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isParameter(p) && p.name === node) || (ts.isVariableDeclaration(p) && p.name === node) || (isFnLike(p) && p.name === node)); };
  const isWrite = (node) => { const p = node.parent; if (!p) return false; if (ts.isBinaryExpression(p) && p.left === node && (p.operatorToken.kind === ts.SyntaxKind.EqualsToken || COMPOUND.has(p.operatorToken.kind))) return true; if ((ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p)) && p.operand === node) return true; return false; };

  const scopes = [];
  const walk = (node) => {
    const fn = isFnLike(node);
    if (fn) {
      const scope = { names: new Map() }; scopes.push(scope);
      const ids = [];
      for (const nameNode of declNames(node)) { const id = next++; scope.names.set(nameNode.text, id); bindingOf.set(nameNode, id); declFn.set(id, node); ids.push(id); }
      bindingsByFn.set(node, ids);
    }
    if (ts.isIdentifier(node) && !isPropName(node)) {
      let id = null, at = -1;
      for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].names.has(node.text)) { id = scopes[i].names.get(node.text); at = i; break; }
      if (id != null) { bindingOf.set(node, id); if (isWrite(node)) assigned.add(id); if (at < scopes.length - 1) captured.add(id); }
    }
    ts.forEachChild(node, walk);
    if (fn) scopes.pop();
  };
  walk(sf);
  const boxed = new Set([...captured].filter((id) => assigned.has(id)));
  return { bindingOf, declFn, bindingsByFn, boxed };
}

export function compileModule(source, { resources = [], entry = "main", file = "app.ts" } = {}) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2020, true);
  const topFns = new Map();
  for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name) topFns.set(s.name.text, s);
  const resourceSet = new Set(resources);
  const { bindingOf, declFn, bindingsByFn, boxed } = resolveBindings(sf);
  const out = {};
  let gen = 0;
  const lineColOf = (node) => { const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf)); return { file, line: lc.line + 1, col: lc.character + 1, text: node.getText(sf).replace(/\s+/g, " ").slice(0, 32) }; };

  const compileTop = (name) => { if (name in out) return; out[name] = null; const c = compileFn(topFns.get(name), name); out[name] = c; };

  function compileFn(node, name) {
    const ids = bindingsByFn.get(node);
    const slotOf = new Map(); ids.forEach((id, i) => slotOf.set(id, i));
    const envIdx = new Map(); const envIds = [];
    const capture = (id) => { if (!envIdx.has(id)) { envIdx.set(id, envIds.length); envIds.push(id); } return envIdx.get(id); };
    const provide = (id) => (slotOf.has(id) ? ["L", slotOf.get(id)] : ["E", capture(id)]);

    const asm = []; const posMap = new Map(); let lab = 0; let here = node;
    const emit = (...x) => { asm.push(x); posMap.set(x, here ? lineColOf(here) : null); };
    const mark = (l) => asm.push(l);
    const label = (s) => `${s}_${gen}_${lab++}`;
    const fail = (nd, m) => { throw new Error(`waso-tsc: ${m}: \`${nd.getText(sf)}\``); };
    const loops = []; // { brk, cont } for break/continue
    const assemble = () => { const labels = {}, code = []; for (const l of asm) (typeof l === "string") ? (labels[l] = code.length) : code.push(l); for (const ins of code) if ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string") ins[1] = labels[ins[1]]; return { code, pos: code.map((ins) => posMap.get(ins) || null) }; };

    function readUse(idNode) {
      const id = bindingOf.get(idNode);
      if (id == null) { if (topFns.has(idNode.text)) { compileTop(idNode.text); emit("MAKECLOSURE", idNode.text, []); return; } fail(idNode, "unresolved identifier"); }
      if (slotOf.has(id)) { emit("LOAD", slotOf.get(id)); if (boxed.has(id)) emit("GETPROP", "v"); return; }
      emit("LOADENV", capture(id)); if (boxed.has(id)) emit("GETPROP", "v");
    }
    function writeUse(idNode, valThunk) {
      const id = bindingOf.get(idNode); if (id == null) fail(idNode, "assign to non-variable");
      if (boxed.has(id)) { if (slotOf.has(id)) emit("LOAD", slotOf.get(id)); else emit("LOADENV", capture(id)); valThunk(); emit("SETPROP", "v"); emit("POP"); return; }
      valThunk(); emit("STORE", slotOf.get(id));
    }
    function closureOf(fnNode) {
      const childName = `${name}$${gen++}`; const child = compileFn(fnNode, childName); out[childName] = child;
      emit("MAKECLOSURE", childName, child.freeIds.map(provide));
    }

    function expr(node) {                                   // returns true if it leaves one value
      const save = here; here = node;
      try { return exprInner(node); } finally { here = save; }
    }
    function exprInner(node) {
      if (ts.isParenthesizedExpression(node)) return expr(node.expression);
      if (ts.isNumericLiteral(node)) { emit("PUSH", Number(node.text)); return true; }
      if (ts.isStringLiteral(node)) { emit("PUSH", node.text); return true; }
      if (node.kind === ts.SyntaxKind.TrueKeyword) { emit("PUSH", true); return true; }
      if (node.kind === ts.SyntaxKind.FalseKeyword) { emit("PUSH", false); return true; }
      if (node.kind === ts.SyntaxKind.MinusToken) { /* handled in prefix */ }
      if (ts.isIdentifier(node)) { readUse(node); return true; }
      if (ts.isAwaitExpression(node)) { expr(node.expression); emit("AWAIT"); return true; }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) { closureOf(node); return true; }
      if (ts.isConditionalExpression(node)) { // c ? t : e
        expr(node.condition); const els = label("tern"), end = label("tend");
        emit("JMPF", els); expr(node.whenTrue); emit("JMP", end); mark(els); expr(node.whenFalse); mark(end); return true;
      }
      if (ts.isPrefixUnaryExpression(node)) {
        if (node.operator === ts.SyntaxKind.ExclamationToken) { expr(node.operand); emit("NOT"); return true; }
        if (node.operator === ts.SyntaxKind.MinusToken) { emit("PUSH", 0); expr(node.operand); emit("BIN", "-"); return true; }
        if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
          const op = node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
          writeUse(node.operand, () => { readUse(node.operand); emit("PUSH", 1); emit("BIN", op); }); return false;
        }
        fail(node, "unsupported unary");
      }
      if (ts.isPostfixUnaryExpression(node)) {
        const op = node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
        writeUse(node.operand, () => { readUse(node.operand); emit("PUSH", 1); emit("BIN", op); }); return false;
      }
      if (ts.isBinaryExpression(node)) {
        const k = node.operatorToken.kind;
        if (k === ts.SyntaxKind.EqualsToken) { if (!ts.isIdentifier(node.left)) fail(node, "can only assign to a variable"); writeUse(node.left, () => expr(node.right)); return false; }
        if (COMPOUND.has(k)) { const op = COMPOUND.get(k); writeUse(node.left, () => { readUse(node.left); expr(node.right); emit("BIN", op); }); return false; }
        if (k === ts.SyntaxKind.AmpersandAmpersandToken) { expr(node.left); emit("DUP"); const end = label("and"); emit("JMPF", end); emit("POP"); expr(node.right); mark(end); return true; }
        if (k === ts.SyntaxKind.BarBarToken) { expr(node.left); emit("DUP"); const rhs = label("or"), end = label("oend"); emit("JMPF", rhs); emit("JMP", end); mark(rhs); emit("POP"); expr(node.right); mark(end); return true; }
        const op = BINOP[k]; if (!op) fail(node, "unsupported operator");
        expr(node.left); expr(node.right); emit("BIN", op); return true;
      }
      if (ts.isPropertyAccessExpression(node)) { expr(node.expression); emit("GETPROP", node.name.text); return true; }
      if (ts.isElementAccessExpression(node)) { expr(node.expression); expr(node.argumentExpression); emit("INDEX"); return true; }
      if (ts.isObjectLiteralExpression(node)) {
        emit("NEWOBJ");
        for (const p of node.properties) {
          if (ts.isPropertyAssignment(p)) { expr(p.initializer); emit("SETPROP", p.name.text); }
          else if (ts.isShorthandPropertyAssignment(p)) { readUse(p.name); emit("SETPROP", p.name.text); }
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
      const resName = ts.isPropertyAccessExpression(callee) ? `${callee.expression.getText(sf)}.${callee.name.text}` : ts.isIdentifier(callee) && bindingOf.get(callee) == null && !topFns.has(callee.text) ? callee.text : null;
      if (resName && resourceSet.has(resName)) { node.arguments.forEach((a) => expr(a)); emit("RES", resName, node.arguments.length); return true; }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "push") { expr(callee.expression); expr(node.arguments[0]); emit("ARRPUSH"); return false; }
      expr(callee); node.arguments.forEach((a) => expr(a)); emit("CALLV", node.arguments.length); return true;
    }

    function stmt(node) {
      const save = here; here = node;
      try { stmtInner(node); } finally { here = save; }
    }
    function stmtInner(node) {
      if (ts.isBlock(node)) return node.statements.forEach(stmt);
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (!d.initializer) fail(d, "needs initializer");
          const id = bindingOf.get(d.name); const slot = slotOf.get(id);
          if (boxed.has(id)) { emit("NEWOBJ"); expr(d.initializer); emit("SETPROP", "v"); emit("STORE", slot); }
          else { expr(d.initializer); emit("STORE", slot); }
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
      if (ts.isWhileStatement(node)) {
        const loop = label("loop"), end = label("end"); mark(loop);
        expr(node.expression); emit("JMPF", end);
        loops.push({ brk: end, cont: loop }); stmt(node.statement); loops.pop();
        emit("JMP", loop); mark(end); return;
      }
      if (ts.isForStatement(node)) {
        if (node.initializer && ts.isVariableDeclarationList(node.initializer)) for (const d of node.initializer.declarations) { expr(d.initializer); emit("STORE", slotOf.get(bindingOf.get(d.name))); }
        const loop = label("loop"), step = label("step"), end = label("end"); mark(loop);
        if (node.condition) { expr(node.condition); emit("JMPF", end); }
        loops.push({ brk: end, cont: step }); stmt(node.statement); loops.pop();
        mark(step); if (node.incrementor) { if (expr(node.incrementor)) emit("POP"); } emit("JMP", loop); mark(end); return;
      }
      if (ts.isBreakStatement(node)) { if (!loops.length) fail(node, "break outside loop"); emit("JMP", loops[loops.length - 1].brk); return; }
      if (ts.isContinueStatement(node)) { if (!loops.length) fail(node, "continue outside loop"); emit("JMP", loops[loops.length - 1].cont); return; }
      fail(node, "unsupported statement");
    }

    const entry = [];
    for (const p of node.parameters) { const id = bindingOf.get(p.name); if (boxed.has(id)) { const s = slotOf.get(id); entry.push(["NEWOBJ"], ["LOAD", s], ["SETPROP", "v"], ["STORE", s]); } }
    for (const e of entry) { posMap.set(e, lineColOf(node)); }
    if (node.body && ts.isBlock(node.body)) node.body.statements.forEach(stmt);
    else { expr(node.body); emit("RET"); }
    const last = asm[asm.length - 1];
    if (!(Array.isArray(last) && last[0] === "RET")) { emit("PUSH", 0); emit("RET"); }
    asm.unshift(...entry);
    const { code, pos } = assemble();
    return { nlocals: ids.length, code, pos, freeIds: envIds };
  }

  compileTop(entry);
  // strip the compiler-only `freeIds` from exported entries
  const frag = {};
  for (const [k, v] of Object.entries(out)) frag[k] = { nlocals: v.nlocals, code: v.code, pos: v.pos };
  return frag;
}

export function loadModule(PROGRAM, source, opts) {
  const frag = compileModule(source, opts);
  for (const [k, v] of Object.entries(frag)) PROGRAM[k] = v;
  return frag;
}

// Map a suspended continuation back to a TS-level stack trace (source maps).
export function describeContinuation(PROGRAM, frames) {
  return frames.map((f, i) => {
    const at = Math.max(0, f.ip - 1);
    const loc = PROGRAM[f.fn] && PROGRAM[f.fn].pos ? PROGRAM[f.fn].pos[at] : null;
    return { depth: frames.length - 1 - i, fn: f.fn, loc };
  });
}
