// Waso — TypeScript -> JS-IR frontend (#4).
//
// Targets the de-risked JS interpreter (waso-core). Lowers a growing subset of
// real TS/JS: closures (closure conversion), `await` as a suspension, mutable
// captured variables (boxing into a shared cell {v}, migration-safe via the
// identity-preserving wire format), binding-keyed scoping (correct lexical
// shadowing), control flow (if/else, for, for-of, while, break/continue, &&/||,
// ternary, assignment, ++/--, += -= *=), template literals, array/object
// literals, default parameters, and nested function declarations. Every emitted
// instruction carries its TS source position, so a serialized continuation maps
// back to a TS stack trace (describeContinuation).
//
// We parse a subset with the TS compiler API; we do not typecheck.

import ts from "typescript";

const BINOP = {
  [ts.SyntaxKind.PlusToken]: "+", [ts.SyntaxKind.MinusToken]: "-", [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.SlashToken]: "/", [ts.SyntaxKind.PercentToken]: "%",
  [ts.SyntaxKind.LessThanToken]: "<", [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.GreaterThanToken]: ">", [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===", [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.EqualsEqualsToken]: "===", [ts.SyntaxKind.ExclamationEqualsToken]: "!==",
};
const COMPOUND = new Map([
  [ts.SyntaxKind.PlusEqualsToken, "+"], [ts.SyntaxKind.MinusEqualsToken, "-"], [ts.SyntaxKind.AsteriskEqualsToken, "*"],
]);
const isFnLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);
const patternIds = (name, out) => {
  if (ts.isIdentifier(name)) out.push(name);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
    for (const el of name.elements) if (ts.isBindingElement(el) && el.name) patternIds(el.name, out);
};

// Assign every binding a unique id (handles shadowing); find which need boxing.
function resolveBindings(sf) {
  let next = 1;
  const bindingOf = new Map(), declFn = new Map(), bindingsByFn = new Map();
  const captured = new Set(), assigned = new Set();
  const declNames = (fn) => {
    const out = [];
    fn.parameters.forEach((p) => patternIds(p.name, out));
    const collect = (n) => {
      if (ts.isFunctionDeclaration(n) && n.name) { out.push(n.name); return; }    // nested fn decl name (hoisted)
      if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
      if (ts.isVariableDeclaration(n)) patternIds(n.name, out);
      ts.forEachChild(n, collect);
    };
    if (fn.body) collect(fn.body);
    return out;
  };
  const isPropName = (node) => { const p = node.parent; return p && ((ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isParameter(p) && p.name === node) || (ts.isVariableDeclaration(p) && p.name === node) || (ts.isBindingElement(p) && p.name === node) || (isFnLike(p) && p.name === node)); };
  const isWrite = (node) => { const p = node.parent; if (!p) return false; if (ts.isBinaryExpression(p) && p.left === node && (p.operatorToken.kind === ts.SyntaxKind.EqualsToken || COMPOUND.has(p.operatorToken.kind))) return true; if ((ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p)) && p.operand === node) return true; return false; };
  const scopes = [];
  const walk = (node) => {
    const fn = isFnLike(node);
    if (fn) { const scope = { names: new Map() }; scopes.push(scope); const ids = []; for (const nameNode of declNames(node)) { const id = next++; scope.names.set(nameNode.text, id); bindingOf.set(nameNode, id); declFn.set(id, node); ids.push(id); } bindingsByFn.set(node, ids); }
    if (ts.isIdentifier(node) && !isPropName(node)) {
      let id = null, at = -1;
      for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].names.has(node.text)) { id = scopes[i].names.get(node.text); at = i; break; }
      if (id != null) { bindingOf.set(node, id); if (isWrite(node)) assigned.add(id); if (at < scopes.length - 1) captured.add(id); }
    }
    ts.forEachChild(node, walk);
    if (fn) scopes.pop();
  };
  walk(sf);
  return { bindingOf, declFn, bindingsByFn, boxed: new Set([...captured].filter((id) => assigned.has(id))) };
}

export function compileModule(source, { resources = [], entry = "main", file = "app.ts" } = {}) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2020, true);
  const topFns = new Map();
  for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name) topFns.set(s.name.text, s);
  const resourceSet = new Set(resources);
  const { bindingOf, bindingsByFn, boxed } = resolveBindings(sf);
  const out = {};
  let gen = 0;
  const lineColOf = (node) => { const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf)); return { file, line: lc.line + 1, col: lc.character + 1, text: node.getText(sf).replace(/\s+/g, " ").slice(0, 32) }; };
  const compileTop = (name) => { if (name in out) return; out[name] = null; out[name] = compileFn(topFns.get(name), name); };

  function compileFn(node, name) {
    const ids = bindingsByFn.get(node);
    const slotOf = new Map(); ids.forEach((id, i) => slotOf.set(id, i));
    let topSlot = ids.length; const tempSlot = () => topSlot++;
    const envIdx = new Map(); const envIds = [];
    const capture = (id) => { if (!envIdx.has(id)) { envIdx.set(id, envIds.length); envIds.push(id); } return envIdx.get(id); };
    const provide = (id) => (slotOf.has(id) ? ["L", slotOf.get(id)] : ["E", capture(id)]);
    const asm = []; const posMap = new Map(); let lab = 0; let here = node;
    const emit = (...x) => { asm.push(x); posMap.set(x, here ? lineColOf(here) : null); };
    const mark = (l) => asm.push(l);
    const label = (s) => `${s}_${gen}_${lab++}`;
    const fail = (nd, m) => { throw new Error(`waso-tsc: ${m}: \`${nd.getText(sf).slice(0, 40)}\``); };
    const loops = [];
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
    function bindStackTop(nameNode) { // a value is on the stack; store into the binding (decl/for-of/destructure)
      const id = bindingOf.get(nameNode);
      if (boxed.has(id)) { const t = tempSlot(); emit("STORE", t); emit("NEWOBJ"); emit("LOAD", t); emit("SETPROP", "v"); emit("STORE", slotOf.get(id)); }
      else emit("STORE", slotOf.get(id));
    }
    function bindPattern(pattern, srcSlot) {
      if (ts.isObjectBindingPattern(pattern)) { for (const el of pattern.elements) { const key = (el.propertyName || el.name).text; emit("LOAD", srcSlot); emit("GETPROP", key); if (ts.isIdentifier(el.name)) bindStackTop(el.name); else { const t = tempSlot(); emit("STORE", t); bindPattern(el.name, t); } } return; }
      if (ts.isArrayBindingPattern(pattern)) { pattern.elements.forEach((el, i) => { if (ts.isOmittedExpression(el)) return; emit("LOAD", srcSlot); emit("PUSH", i); emit("INDEX"); if (ts.isIdentifier(el.name)) bindStackTop(el.name); else { const t = tempSlot(); emit("STORE", t); bindPattern(el.name, t); } }); return; }
      fail(pattern, "unsupported binding pattern");
    }
    function closureOf(fnNode) { const childName = `${name}$${gen++}`; const child = compileFn(fnNode, childName); out[childName] = child; emit("MAKECLOSURE", childName, child.freeIds.map(provide)); }

    function expr(node) { const save = here; here = node; try { return exprInner(node); } finally { here = save; } }
    function exprInner(node) {
      if (ts.isParenthesizedExpression(node)) return expr(node.expression);
      if (ts.isNumericLiteral(node)) { emit("PUSH", Number(node.text)); return true; }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { emit("PUSH", node.text); return true; }
      if (ts.isTemplateExpression(node)) { emit("PUSH", node.head.text); for (const span of node.templateSpans) { expr(span.expression); emit("BIN", "+"); emit("PUSH", span.literal.text); emit("BIN", "+"); } return true; }
      if (node.kind === ts.SyntaxKind.TrueKeyword) { emit("PUSH", true); return true; }
      if (node.kind === ts.SyntaxKind.FalseKeyword) { emit("PUSH", false); return true; }
      if (ts.isIdentifier(node)) { readUse(node); return true; }
      if (ts.isAwaitExpression(node)) { expr(node.expression); emit("AWAIT"); return true; }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) { closureOf(node); return true; }
      if (ts.isConditionalExpression(node)) { expr(node.condition); const els = label("tern"), end = label("tend"); emit("JMPF", els); expr(node.whenTrue); emit("JMP", end); mark(els); expr(node.whenFalse); mark(end); return true; }
      if (ts.isPrefixUnaryExpression(node)) {
        if (node.operator === ts.SyntaxKind.ExclamationToken) { expr(node.operand); emit("NOT"); return true; }
        if (node.operator === ts.SyntaxKind.MinusToken) { emit("PUSH", 0); expr(node.operand); emit("BIN", "-"); return true; }
        if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) { const op = node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-"; writeUse(node.operand, () => { readUse(node.operand); emit("PUSH", 1); emit("BIN", op); }); return false; }
        fail(node, "unsupported unary");
      }
      if (ts.isPostfixUnaryExpression(node)) { const op = node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-"; writeUse(node.operand, () => { readUse(node.operand); emit("PUSH", 1); emit("BIN", op); }); return false; }
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
      if (ts.isObjectLiteralExpression(node)) { emit("NEWOBJ"); for (const p of node.properties) { if (ts.isPropertyAssignment(p)) { expr(p.initializer); emit("SETPROP", p.name.text); } else if (ts.isShorthandPropertyAssignment(p)) { readUse(p.name); emit("SETPROP", p.name.text); } else fail(p, "unsupported property"); } return true; }
      if (ts.isArrayLiteralExpression(node)) { emit("NEWARR"); for (const el of node.elements) { emit("DUP"); expr(el); emit("ARRPUSH"); } return true; }
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

    function declOne(d) {
      if (ts.isIdentifier(d.name)) { const id = bindingOf.get(d.name); if (boxed.has(id)) { emit("NEWOBJ"); expr(d.initializer); emit("SETPROP", "v"); emit("STORE", slotOf.get(id)); } else { expr(d.initializer); emit("STORE", slotOf.get(id)); } return; }
      const t = tempSlot(); expr(d.initializer); emit("STORE", t); bindPattern(d.name, t); // destructuring
    }

    function stmt(node) { const save = here; here = node; try { stmtInner(node); } finally { here = save; } }
    function stmtInner(node) {
      if (ts.isBlock(node)) return node.statements.forEach(stmt);
      if (ts.isFunctionDeclaration(node)) return;                  // nested fn decl: hoisted in the prologue
      if (ts.isVariableStatement(node)) { for (const d of node.declarationList.declarations) { if (!d.initializer) fail(d, "needs initializer"); declOne(d); } return; }
      if (ts.isExpressionStatement(node)) { if (expr(node.expression)) emit("POP"); return; }
      if (ts.isReturnStatement(node)) { if (!node.expression) emit("PUSH", 0); else expr(node.expression); emit("RET"); return; }
      if (ts.isIfStatement(node)) { expr(node.expression); const els = label("else"), end = label("end"); emit("JMPF", node.elseStatement ? els : end); stmt(node.thenStatement); if (node.elseStatement) { emit("JMP", end); mark(els); stmt(node.elseStatement); } mark(end); return; }
      if (ts.isWhileStatement(node)) { const loop = label("loop"), end = label("end"); mark(loop); expr(node.expression); emit("JMPF", end); loops.push({ brk: end, cont: loop }); stmt(node.statement); loops.pop(); emit("JMP", loop); mark(end); return; }
      if (ts.isForStatement(node)) {
        if (node.initializer && ts.isVariableDeclarationList(node.initializer)) for (const d of node.initializer.declarations) declOne(d);
        const loop = label("loop"), step = label("step"), end = label("end"); mark(loop);
        if (node.condition) { expr(node.condition); emit("JMPF", end); }
        loops.push({ brk: end, cont: step }); stmt(node.statement); loops.pop();
        mark(step); if (node.incrementor) { if (expr(node.incrementor)) emit("POP"); } emit("JMP", loop); mark(end); return;
      }
      if (ts.isForOfStatement(node)) {
        const iter = tempSlot(), idx = tempSlot();
        expr(node.expression); emit("STORE", iter); emit("PUSH", 0); emit("STORE", idx);
        const loop = label("loop"), step = label("step"), end = label("end"); mark(loop);
        emit("LOAD", idx); emit("LOAD", iter); emit("GETPROP", "length"); emit("BIN", "<"); emit("JMPF", end);
        const decl = node.initializer.declarations[0];
        emit("LOAD", iter); emit("LOAD", idx); emit("INDEX");
        if (ts.isIdentifier(decl.name)) bindStackTop(decl.name); else { const t = tempSlot(); emit("STORE", t); bindPattern(decl.name, t); }
        loops.push({ brk: end, cont: step }); stmt(node.statement); loops.pop();
        mark(step); emit("LOAD", idx); emit("PUSH", 1); emit("BIN", "+"); emit("STORE", idx); emit("JMP", loop); mark(end); return;
      }
      if (ts.isBreakStatement(node)) { if (!loops.length) fail(node, "break outside loop"); emit("JMP", loops[loops.length - 1].brk); return; }
      if (ts.isContinueStatement(node)) { if (!loops.length) fail(node, "continue outside loop"); emit("JMP", loops[loops.length - 1].cont); return; }
      fail(node, "unsupported statement");
    }

    // --- prologue: default params, box captured params, hoist nested fn decls
    for (const p of node.parameters) if (p.initializer && ts.isIdentifier(p.name)) { const s = slotOf.get(bindingOf.get(p.name)); const skip = label("dflt"); emit("LOAD", s); emit("PUSH", undefined); emit("BIN", "==="); emit("JMPF", skip); expr(p.initializer); emit("STORE", s); mark(skip); }
    for (const p of node.parameters) if (ts.isIdentifier(p.name) && boxed.has(bindingOf.get(p.name))) { const s = slotOf.get(bindingOf.get(p.name)); emit("NEWOBJ"); emit("LOAD", s); emit("SETPROP", "v"); emit("STORE", s); }
    const hoist = []; const findFnDecls = (n) => { if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return; if (ts.isFunctionDeclaration(n) && n !== node) { hoist.push(n); return; } ts.forEachChild(n, findFnDecls); };
    if (node.body) ts.forEachChild(node.body, findFnDecls);
    for (const fd of hoist) { const childName = `${name}$${gen++}`; const child = compileFn(fd, childName); out[childName] = child; emit("MAKECLOSURE", childName, child.freeIds.map(provide)); bindStackTop(fd.name); }

    if (node.body && ts.isBlock(node.body)) node.body.statements.forEach(stmt);
    else { expr(node.body); emit("RET"); }
    const last = asm[asm.length - 1];
    if (!(Array.isArray(last) && last[0] === "RET")) { emit("PUSH", 0); emit("RET"); }
    const { code, pos } = assemble();
    return { nlocals: topSlot, code, pos, freeIds: envIds };
  }

  compileTop(entry);
  const frag = {};
  for (const [k, v] of Object.entries(out)) frag[k] = { nlocals: v.nlocals, code: v.code, pos: v.pos };
  return frag;
}

export function loadModule(PROGRAM, source, opts) { const frag = compileModule(source, opts); for (const [k, v] of Object.entries(frag)) PROGRAM[k] = v; return frag; }

export function describeContinuation(PROGRAM, frames) {
  return frames.map((f, i) => { const at = Math.max(0, f.ip - 1); const loc = PROGRAM[f.fn] && PROGRAM[f.fn].pos ? PROGRAM[f.fn].pos[at] : null; return { depth: frames.length - 1 - i, fn: f.fn, loc }; });
}
