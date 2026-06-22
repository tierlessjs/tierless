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
  [ts.SyntaxKind.SlashToken]: "/", [ts.SyntaxKind.PercentToken]: "%", [ts.SyntaxKind.AsteriskAsteriskToken]: "**",
  [ts.SyntaxKind.LessThanToken]: "<", [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.GreaterThanToken]: ">", [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===", [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.EqualsEqualsToken]: "==", [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
  [ts.SyntaxKind.InKeyword]: "in",
  [ts.SyntaxKind.AmpersandToken]: "&", [ts.SyntaxKind.BarToken]: "|", [ts.SyntaxKind.CaretToken]: "^",
  [ts.SyntaxKind.LessThanLessThanToken]: "<<", [ts.SyntaxKind.GreaterThanGreaterThanToken]: ">>", [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: ">>>",
};
const COMPOUND = new Map([
  [ts.SyntaxKind.PlusEqualsToken, "+"], [ts.SyntaxKind.MinusEqualsToken, "-"], [ts.SyntaxKind.AsteriskEqualsToken, "*"],
]);
const isFnLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
const isAccess = (n) => ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n);
const isChainRoot = (n) => ts.isOptionalChain(n) && !(n.parent && isAccess(n.parent) && n.parent.expression === n && ts.isOptionalChain(n.parent));
const HOF = new Set(["map", "filter", "forEach", "reduce"]); // callback is a Waso closure -> inline-compiled
const PLAIN_METHODS = new Set(["slice", "indexOf", "lastIndexOf", "includes", "join", "concat", "toUpperCase",
  "toLowerCase", "split", "trim", "trimStart", "trimEnd", "charAt", "charCodeAt", "substring", "substr", "repeat",
  "padStart", "padEnd", "startsWith", "endsWith", "replace", "replaceAll", "toFixed", "at",
  "test", "exec", "match", "matchAll", "search", "reverse", "fill", "toString", "valueOf"]); // host intrinsics (incl. regex)
const patternIds = (name, out) => {
  if (ts.isIdentifier(name)) out.push(name);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
    for (const el of name.elements) if (ts.isBindingElement(el) && el.name) patternIds(el.name, out);
};

// Assign every binding a unique id with proper LEXICAL scoping: let/const/class are
// block-scoped, var/params/function-declarations are function-scoped. So two
// same-named block-locals in one function (e.g. `for (const v ...) {}` twice) are
// distinct bindings. A binding gets a slot in its OWNING function's frame; capture
// = used from a deeper function than the one that owns it. Finds which need boxing.
function resolveBindings(sf) {
  let next = 1;
  const bindingOf = new Map(), declFn = new Map(), bindingsByFn = new Map();
  const captured = new Set(), assigned = new Set(), forceBox = new Set();
  const isPropName = (node) => { const p = node.parent; return p && ((ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isParameter(p) && p.name === node) || (ts.isVariableDeclaration(p) && p.name === node) || (ts.isBindingElement(p) && p.name === node) || (isFnLike(p) && p.name === node)); };
  const isWrite = (node) => { const p = node.parent; if (!p) return false; if (ts.isBinaryExpression(p) && p.left === node && (p.operatorToken.kind === ts.SyntaxKind.EqualsToken || COMPOUND.has(p.operatorToken.kind))) return true; if ((ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p)) && p.operand === node) return true; return false; };
  const isLexical = (flags) => !!(flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));

  const scopes = [];                          // { kind:"fn"|"block", names:Map, fnNode }
  const curFn = () => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].kind === "fn") return scopes[i].fnNode; return null; };
  const declareIn = (scope, nameNode) => { const id = next++; scope.names.set(nameNode.text, id); bindingOf.set(nameNode, id); declFn.set(id, scope.fnNode); if (!bindingsByFn.has(scope.fnNode)) bindingsByFn.set(scope.fnNode, []); bindingsByFn.get(scope.fnNode).push(id); return id; };
  // function-scoped names: params + `var`s + nested function-declaration names (don't descend into nested fns)
  const hoistFn = (fnNode, scope) => {
    fnNode.parameters.forEach((p) => { const ids = []; patternIds(p.name, ids); ids.forEach((nm) => declareIn(scope, nm)); });
    const rec = (n) => {
      if (n !== fnNode && isFnLike(n)) { if (ts.isFunctionDeclaration(n) && n.name) forceBox.add(declareIn(scope, n.name)); return; } // nested fn decl name -> live binding (recursion + capture timing)
      const isVarList = (l) => l && ts.isVariableDeclarationList(l) && !isLexical(l.flags);
      if (ts.isVariableStatement(n) && isVarList(n.declarationList)) for (const d of n.declarationList.declarations) { const ids = []; patternIds(d.name, ids); ids.forEach((nm) => declareIn(scope, nm)); }
      if ((ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) && isVarList(n.initializer)) for (const d of n.initializer.declarations) { const ids = []; patternIds(d.name, ids); ids.forEach((nm) => declareIn(scope, nm)); }
      ts.forEachChild(n, rec);
    };
    if (fnNode.body) rec(fnNode.body);
  };
  // block-scoped names declared directly in a block: let/const + class (functions are hoisted to the fn scope)
  const hoistBlock = (statements, scope) => { for (const st of statements) { if (ts.isVariableStatement(st) && isLexical(st.declarationList.flags)) for (const d of st.declarationList.declarations) { const ids = []; patternIds(d.name, ids); ids.forEach((nm) => declareIn(scope, nm)); } else if (ts.isClassDeclaration(st) && st.name) declareIn(scope, st.name); } };
  const headerLets = (init, scope) => { if (init && ts.isVariableDeclarationList(init) && isLexical(init.flags)) for (const d of init.declarations) { const ids = []; patternIds(d.name, ids); ids.forEach((nm) => declareIn(scope, nm)); } };

  const walk = (node) => {
    if (node == null) return;
    if (isFnLike(node)) {
      const scope = { kind: "fn", names: new Map(), fnNode: node }; scopes.push(scope);
      if (!bindingsByFn.has(node)) bindingsByFn.set(node, []);
      hoistFn(node, scope);
      node.parameters.forEach((p) => p.initializer && walk(p.initializer)); // default-param exprs resolve in the fn scope
      walk(node.body);
      scopes.pop(); return;
    }
    if (ts.isBlock(node)) { const s = { kind: "block", names: new Map(), fnNode: curFn() }; scopes.push(s); hoistBlock(node.statements, s); node.statements.forEach(walk); scopes.pop(); return; }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) { const s = { kind: "block", names: new Map(), fnNode: curFn() }; scopes.push(s); headerLets(node.initializer, s); ts.forEachChild(node, walk); scopes.pop(); return; }
    if (ts.isCatchClause(node)) { const s = { kind: "block", names: new Map(), fnNode: curFn() }; scopes.push(s); if (node.variableDeclaration) { const ids = []; patternIds(node.variableDeclaration.name, ids); ids.forEach((nm) => declareIn(s, nm)); } ts.forEachChild(node, walk); scopes.pop(); return; }
    if (ts.isIdentifier(node) && !isPropName(node)) {
      for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].names.has(node.text)) { const id = scopes[i].names.get(node.text); bindingOf.set(node, id); if (isWrite(node)) assigned.add(id); if (scopes[i].fnNode !== curFn()) captured.add(id); return; }
      return;
    }
    ts.forEachChild(node, walk);
  };
  sf.statements.forEach(walk);
  const boxed = new Set([...captured].filter((id) => assigned.has(id)));
  for (const id of forceBox) boxed.add(id);
  return { bindingOf, declFn, bindingsByFn, boxed };
}

export function compileModule(source, { resources = [], entry = "main", file = "app.ts" } = {}) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2020, true);
  const topFns = new Map();
  const generatorFns = new Set();   // top-level `function*` names -> a call makes an iterator, not a normal call
  for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name) { topFns.set(s.name.text, s); if (s.asteriskToken) generatorFns.add(s.name.text); }
  // Classes: an instance is an object whose method properties are closures
  // capturing `this`; the constructor (with field inits prepended) runs at `new`.
  const classes = new Map();
  const accessorNames = new Set();   // property names that are a get/set in SOME class -> read/write uses the accessor-aware op
  let thisCounter = -1;
  for (const s of sf.statements) if (ts.isClassDeclaration(s) && s.name) {
    let superName = null;
    for (const h of s.heritageClauses || []) if (h.token === ts.SyntaxKind.ExtendsKeyword && ts.isIdentifier(h.types[0].expression)) superName = h.types[0].expression.text;
    const isStatic = (mem) => (mem.modifiers || []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
    const fields = [], methods = [], accessors = [], sfields = [], smethods = [], saccessors = []; let ctor = null;
    for (const mem of s.members) {
      const st = isStatic(mem);
      if (ts.isPropertyDeclaration(mem) && mem.initializer && ts.isIdentifier(mem.name)) (st ? sfields : fields).push({ name: mem.name.text, init: mem.initializer });
      else if (ts.isMethodDeclaration(mem) && ts.isIdentifier(mem.name)) (st ? smethods : methods).push({ name: mem.name.text, node: mem });
      else if (ts.isGetAccessorDeclaration(mem) && ts.isIdentifier(mem.name)) { (st ? saccessors : accessors).push({ name: mem.name.text, kind: "get", node: mem }); accessorNames.add(mem.name.text); }
      else if (ts.isSetAccessorDeclaration(mem) && ts.isIdentifier(mem.name)) { (st ? saccessors : accessors).push({ name: mem.name.text, kind: "set", node: mem }); accessorNames.add(mem.name.text); }
      else if (ts.isConstructorDeclaration(mem) && mem.body) ctor = mem;
    }
    classes.set(s.name.text, { name: s.name.text, thisId: thisCounter--, staticThisId: thisCounter--, fields, methods, accessors, sfields, smethods, saccessors, ctor, superName });
  }
  const resourceSet = new Set(resources);
  const { bindingOf, bindingsByFn, boxed } = resolveBindings(sf);
  const out = {};
  let gen = 0;
  const neededBuilders = new Set();   // classes whose class-object builder (%Name) must be generated
  const lineColOf = (node) => { if (!node || !node.getStart) return null; const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf)); return { file, line: lc.line + 1, col: lc.character + 1, text: node.getText(sf).replace(/\s+/g, " ").slice(0, 32) }; };
  // The class object: a singleton (statics live on it), built-or-returned by a
  // 0-arg builder fn, cached per tier (CLSGET/CLSPUT). Emitted as raw IR via
  // compileFn's emitBody hook so static-field initializers reuse expr().
  const buildClassObjectBody = (cname, { emit, expr, tempSlot, label, mark, provide }) => {
    const rec = compileClass(cname);
    const chain = []; for (let c = rec; c; c = c.superName ? compileClass(c.superName) : null) chain.unshift(c); // base-first; derived overrides
    const ready = label("clsr");
    emit("CLSGET", cname); emit("DUP"); emit("ISNULLISH"); emit("JMPF", ready); emit("POP"); // cached -> return it
    const co = tempSlot(); emit("NEWOBJ"); emit("STORE", co);
    emit("LOAD", co); emit("PUSH", chain.map((c) => c.name)); emit("SETPROP", "__class__"); emit("POP");
    for (const cls of chain) for (const m of cls.smethods) { const info = cls.compiled[`static ${m.name}`]; emit("LOAD", co); emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === cls.staticThisId ? ["L", co] : provide(id))), !!m.node.asteriskToken); emit("SETPROP", m.name); emit("POP"); }
    for (const cls of chain) for (const fld of cls.sfields) { emit("LOAD", co); expr(fld.init); emit("SETPROP", fld.name); emit("POP"); } // init runs code
    const accs = new Map();
    for (const cls of chain) for (const a of cls.saccessors) { const e = accs.get(a.name) || {}; e[a.kind] = { cls, info: cls.compiled[`static ${a.kind} ${a.name}`] }; accs.set(a.name, e); }
    if (accs.size) {
      const tbl = tempSlot(); emit("NEWOBJ"); emit("STORE", tbl);
      for (const [aname, e] of accs) {
        const ent = tempSlot(); emit("NEWOBJ"); emit("STORE", ent);
        for (const kind of ["get", "set"]) { const s = e[kind]; if (!s) continue; emit("LOAD", ent); emit("MAKECLOSURE", s.info.prog, s.info.freeIds.map((id) => (id === s.cls.staticThisId ? ["L", co] : provide(id)))); emit("SETPROP", kind); emit("POP"); }
        emit("LOAD", tbl); emit("LOAD", ent); emit("SETPROP", aname); emit("POP");
      }
      emit("LOAD", co); emit("LOAD", tbl); emit("SETPROP", "__accessors__"); emit("POP");
    }
    emit("LOAD", co); emit("CLSPUT", cname); emit("RET");           // cache & return
    mark(ready); emit("RET");                                       // cached value already on stack
  };
  const compileTop = (name) => { if (name in out) return; out[name] = null; out[name] = compileFn(topFns.get(name), name); };
  const compileClass = (cname) => {
    const rec = classes.get(cname); if (rec.compiled) return rec;
    if (rec.superName) compileClass(rec.superName);
    rec.compiled = {};
    const o = { thisId: rec.thisId, superName: rec.superName };
    for (const m of rec.methods) { const prog = `${cname}#${m.name}`; const c = compileFn(m.node, prog, o); out[prog] = c; rec.compiled[m.name] = { prog, freeIds: c.freeIds }; }
    for (const a of rec.accessors) { const prog = `${cname}#${a.kind} ${a.name}`; const c = compileFn(a.node, prog, o); out[prog] = c; rec.compiled[`${a.kind} ${a.name}`] = { prog, freeIds: c.freeIds }; }
    const so = { thisId: rec.staticThisId, superName: rec.superName }; // static `this` = the class object
    for (const m of rec.smethods) { const prog = `${cname}#static ${m.name}`; const c = compileFn(m.node, prog, so); out[prog] = c; rec.compiled[`static ${m.name}`] = { prog, freeIds: c.freeIds }; }
    for (const a of rec.saccessors) { const prog = `${cname}#static ${a.kind} ${a.name}`; const c = compileFn(a.node, prog, so); out[prog] = c; rec.compiled[`static ${a.kind} ${a.name}`] = { prog, freeIds: c.freeIds }; }
    if (rec.ctor) { const prog = `${cname}#constructor`; const c = compileFn(rec.ctor, prog, { ...o, fieldInits: rec.fields }); out[prog] = c; rec.compiled.__ctor__ = { prog, freeIds: c.freeIds }; }
    return rec;
  };

  function compileFn(node, name, opts = {}) {
    const ids = bindingsByFn.get(node) || []; // synthetic builders (emitBody) have no bindings
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
    // Accessor-aware property ops only for names that are a get/set SOMEWHERE; every
    // other read/write stays the plain (branchless) op. Falls through to a plain
    // field at runtime when the actual receiver has no such accessor.
    const getOp = (name) => (accessorNames.has(name) ? "GETPROPA" : "GETPROP");
    const setOp = (name) => (accessorNames.has(name) ? "SETPROPA" : "SETPROP");
    // Unified control-flow stack (innermost last): loop/switch break-continue
    // targets AND active try handlers / finally blocks. break/continue/return
    // that cross a try must POPTRY its handler and run its finally first; this is
    // how an abrupt completion routes through finally (full JS semantics).
    const cf = [];
    let pendingLabel = null; const takeLabel = () => { const l = pendingLabel; pendingLabel = null; return l; }; // label attaches to the next loop
    const targetFor = (kind) => { for (let i = cf.length - 1; i >= 0; i--) { const e = cf[i]; if (kind === "break" && (e.loop || e.swtch)) return i; if (kind === "continue" && e.loop) return i; } return -1; };
    const targetForLabel = (name, kind) => { for (let i = cf.length - 1; i >= 0; i--) { const e = cf[i]; if (e.name === name && (kind === "break" || e.loop)) return i; } return -1; };
    const crossedHasFin = (stop) => { for (let i = cf.length - 1; i > stop; i--) if (cf[i].fin) return true; return false; };
    function unwind(stop) { // emit POPTRY + inline finally for every try crossed, innermost first
      for (let i = cf.length - 1; i > stop; i--) {
        const e = cf[i];
        if (e.tryPop) emit("POPTRY");
        if (e.fin) { const removed = cf.splice(i); stmt(e.fin); cf.push(...removed); } // finally (+ inner) not active while emitting itself
      }
    }
    const assemble = () => { const labels = {}, code = []; for (const l of asm) (typeof l === "string") ? (labels[l] = code.length) : code.push(l); for (const ins of code) if ((ins[0] === "JMP" || ins[0] === "JMPF" || ins[0] === "PUSHTRY") && typeof ins[1] === "string") ins[1] = labels[ins[1]]; return { code, pos: code.map((ins) => posMap.get(ins) || null) }; };

    // Bare `ClassName` -> call its class-object builder (`%ClassName`), a 0-arg
    // top-level fn that builds-or-returns the cached singleton. Generated AFTER all
    // classes compile (so static-method freeIds are known), avoiding the re-entrancy
    // when a static method references its own class mid-compile.
    function classObject(cname) { compileClass(cname); neededBuilders.add(cname); emit("MAKECLOSURE", `%${cname}`, []); emit("CALLV", 0); return true; }
    function readUse(idNode) {
      const id = bindingOf.get(idNode);
      if (id == null) {
        if (topFns.has(idNode.text)) { compileTop(idNode.text); emit("MAKECLOSURE", idNode.text, [], generatorFns.has(idNode.text)); return; }
        if (classes.has(idNode.text)) { classObject(idNode.text); return; }  // bare `ClassName` -> the class object
        if (idNode.text === "undefined") { emit("PUSH", undefined); return; }
        if (idNode.text === "NaN") { emit("PUSH", NaN); return; }
        if (idNode.text === "Infinity") { emit("PUSH", Infinity); return; }
        fail(idNode, "unresolved identifier");
      }
      if (slotOf.has(id)) { emit("LOAD", slotOf.get(id)); if (boxed.has(id)) emit("GETPROP", "v"); return; }
      emit("LOADENV", capture(id)); if (boxed.has(id)) emit("GETPROP", "v");
    }
    function writeUse(idNode, valThunk) {
      const id = bindingOf.get(idNode); if (id == null) fail(idNode, "assign to non-variable");
      if (boxed.has(id)) { if (slotOf.has(id)) emit("LOAD", slotOf.get(id)); else emit("LOADENV", capture(id)); valThunk(); emit("SETPROP", "v"); emit("POP"); return; }
      valThunk(); emit("STORE", slotOf.get(id));
    }
    function assignTo(target, valThunk) {      // target = e (returns nothing; statement-shaped)
      if (ts.isIdentifier(target)) { writeUse(target, valThunk); return; }
      if (ts.isPropertyAccessExpression(target)) { expr(target.expression); valThunk(); emit(setOp(target.name.text), target.name.text); emit("POP"); return; }
      if (ts.isElementAccessExpression(target)) { expr(target.expression); expr(target.argumentExpression); valThunk(); emit("SETINDEX"); return; }
      fail(target, "unsupported assignment target");
    }
    function compoundTo(target, op, rhs) {     // target op= rhs
      if (ts.isIdentifier(target)) { writeUse(target, () => { readUse(target); expr(rhs); emit("BIN", op); }); return; }
      if (ts.isPropertyAccessExpression(target)) { expr(target.expression); emit("DUP"); emit(getOp(target.name.text), target.name.text); expr(rhs); emit("BIN", op); emit(setOp(target.name.text), target.name.text); emit("POP"); return; }
      fail(target, "unsupported compound-assignment target");
    }
    function incDec(target, op) {              // target++ / target-- / ++target  (type-aware: INC/DEC pick 1 vs 1n)
      const step = op === "+" ? "INC" : "DEC";
      if (ts.isIdentifier(target)) { writeUse(target, () => { readUse(target); emit(step); }); return; }
      if (ts.isPropertyAccessExpression(target)) { expr(target.expression); emit("DUP"); emit(getOp(target.name.text), target.name.text); emit(step); emit(setOp(target.name.text), target.name.text); emit("POP"); return; }
      fail(target, "unsupported ++/-- target");
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
    function closureOf(fnNode) { const childName = `${name}$${gen++}`; const child = compileFn(fnNode, childName); out[childName] = child; emit("MAKECLOSURE", childName, child.freeIds.map(provide), !!fnNode.asteriskToken); }

    function optChain(node) {                                   // `?.` chain with short-circuit to the chain end
      const end = label("oc");
      const walk = (n) => {
        const base = n.expression;
        if (isAccess(base)) walk(base); else expr(base);
        if (n.questionDotToken) { emit("DUP"); emit("ISNULLISH"); const cont = label("occ"); emit("JMPF", cont); emit("POP"); emit("PUSH", undefined); emit("JMP", end); mark(cont); }
        if (ts.isPropertyAccessExpression(n)) emit(getOp(n.name.text), n.name.text);
        else if (ts.isElementAccessExpression(n)) { expr(n.argumentExpression); emit("INDEX"); }
        else if (ts.isCallExpression(n)) { n.arguments.forEach((a) => expr(a)); emit("CALLV", n.arguments.length); }
      };
      walk(node); mark(end); return true;
    }

    function expr(node) { const save = here; here = node; try { return exprInner(node); } finally { here = save; } }
    function exprInner(node) {
      if (ts.isParenthesizedExpression(node)) return expr(node.expression);
      if (isAccess(node) && isChainRoot(node)) return optChain(node);
      if (ts.isNumericLiteral(node)) { emit("PUSH", Number(node.text)); return true; }
      if (ts.isBigIntLiteral(node)) { emit("PUSH", BigInt(node.text.slice(0, -1))); return true; } // `123n` -> 123n (hex/oct/bin too)
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { emit("PUSH", node.text); return true; }
      if (ts.isTemplateExpression(node)) { emit("PUSH", node.head.text); for (const span of node.templateSpans) { expr(span.expression); emit("BIN", "+"); emit("PUSH", span.literal.text); emit("BIN", "+"); } return true; }
      if (node.kind === ts.SyntaxKind.TrueKeyword) { emit("PUSH", true); return true; }
      if (node.kind === ts.SyntaxKind.FalseKeyword) { emit("PUSH", false); return true; }
      if (node.kind === ts.SyntaxKind.NullKeyword) { emit("PUSH", null); return true; }
      if (node.kind === ts.SyntaxKind.ThisKeyword) { if (opts.thisId == null) fail(node, "`this` outside a method"); emit("LOADENV", capture(opts.thisId)); return true; }
      if (ts.isNewExpression(node)) {
        if (!ts.isIdentifier(node.expression) || !classes.has(node.expression.text)) fail(node, "unsupported `new`");
        const rec = compileClass(node.expression.text);
        const chain = []; for (let c = rec; c; c = c.superName ? compileClass(c.superName) : null) chain.unshift(c); // base-first
        const inst = tempSlot(); emit("NEWOBJ"); emit("STORE", inst);
        emit("LOAD", inst); emit("PUSH", chain.map((c) => c.name)); emit("SETPROP", "__class__"); emit("POP"); // tag for instanceof (base..derived)
        for (const cls of chain) for (const m of cls.methods) { const info = cls.compiled[m.name]; emit("LOAD", inst); emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === cls.thisId ? ["L", inst] : provide(id))), !!m.node.asteriskToken); emit("SETPROP", m.name); emit("POP"); } // derived overrides base
        const accs = new Map(); // name -> { get?: {cls,info}, set?: {cls,info} }, derived overriding base
        for (const cls of chain) for (const a of cls.accessors) { const e = accs.get(a.name) || {}; e[a.kind] = { cls, info: cls.compiled[`${a.kind} ${a.name}`] }; accs.set(a.name, e); }
        if (accs.size) {                                            // build the instance's __accessors__ table (closures capture this)
          const tbl = tempSlot(); emit("NEWOBJ"); emit("STORE", tbl);
          for (const [aname, e] of accs) {
            const ent = tempSlot(); emit("NEWOBJ"); emit("STORE", ent);
            for (const kind of ["get", "set"]) { const s = e[kind]; if (!s) continue; emit("LOAD", ent); emit("MAKECLOSURE", s.info.prog, s.info.freeIds.map((id) => (id === s.cls.thisId ? ["L", inst] : provide(id)))); emit("SETPROP", kind); emit("POP"); }
            emit("LOAD", tbl); emit("LOAD", ent); emit("SETPROP", aname); emit("POP");
          }
          emit("LOAD", inst); emit("LOAD", tbl); emit("SETPROP", "__accessors__"); emit("POP");
        }
        const args = node.arguments || [];
        if (rec.ctor) { const info = rec.compiled.__ctor__; emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === rec.thisId ? ["L", inst] : provide(id)))); args.forEach((a) => expr(a)); emit("CALLV", args.length); emit("POP"); }
        else if (rec.superName) fail(node, "a derived class needs an explicit constructor");
        else for (const f of rec.fields) { emit("LOAD", inst); expr(f.init); emit("SETPROP", f.name); emit("POP"); }
        emit("LOAD", inst); return true;
      }
      if (ts.isIdentifier(node)) { readUse(node); return true; }
      if (ts.isAwaitExpression(node)) { expr(node.expression); emit("AWAIT"); return true; }
      if (ts.isYieldExpression(node)) {
        if (node.asteriskToken) {                                 // yield* E: drive E's iterator, yielding each; result = E's return value
          const it = tempSlot(); expr(node.expression); emit("ITER"); emit("STORE", it);
          const loop = label("ys"), body = label("ysb"), end = label("yse"); mark(loop);
          emit("LOAD", it); emit("ITERNEXT"); emit("JMPF", body); emit("JMP", end);  // done -> return value stays on stack
          mark(body); emit("YIELD"); emit("POP"); emit("JMP", loop);                 // yield value; drop the sent value (not forwarded)
          mark(end); return true;
        }
        node.expression ? expr(node.expression) : emit("PUSH", undefined); emit("YIELD"); return true; // YIELD leaves the sent value as the expr's value
      }
      if (ts.isTypeOfExpression(node)) { expr(node.expression); emit("TYPEOF"); return true; }
      if (ts.isVoidExpression(node)) { expr(node.expression); emit("POP"); emit("PUSH", undefined); return true; }
      if (ts.isRegularExpressionLiteral(node)) { const m = node.text.match(/^\/(.*)\/([a-z]*)$/s); emit("PUSH", new RegExp(m[1], m[2])); return true; }
      if (ts.isDeleteExpression(node)) { const t = node.expression; if (ts.isPropertyAccessExpression(t)) { expr(t.expression); emit("DELPROP", t.name.text); } else if (ts.isElementAccessExpression(t)) { expr(t.expression); expr(t.argumentExpression); emit("DELINDEX"); } else fail(node, "unsupported delete"); return true; }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) { closureOf(node); return true; }
      if (ts.isConditionalExpression(node)) { expr(node.condition); const els = label("tern"), end = label("tend"); emit("JMPF", els); expr(node.whenTrue); emit("JMP", end); mark(els); expr(node.whenFalse); mark(end); return true; }
      if (ts.isPrefixUnaryExpression(node)) {
        if (node.operator === ts.SyntaxKind.ExclamationToken) { expr(node.operand); emit("NOT"); return true; }
        if (node.operator === ts.SyntaxKind.TildeToken) { expr(node.operand); emit("BITNOT"); return true; }
        if (node.operator === ts.SyntaxKind.MinusToken) { emit("PUSH", 0); expr(node.operand); emit("BIN", "-"); return true; }
        if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) { incDec(node.operand, node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-"); return false; }
        fail(node, "unsupported unary");
      }
      if (ts.isPostfixUnaryExpression(node)) { incDec(node.operand, node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-"); return false; }
      if (ts.isBinaryExpression(node)) {
        const k = node.operatorToken.kind;
        if (k === ts.SyntaxKind.EqualsToken) { assignTo(node.left, () => expr(node.right)); return false; }
        if (COMPOUND.has(k)) { compoundTo(node.left, COMPOUND.get(k), node.right); return false; }
        if (k === ts.SyntaxKind.AmpersandAmpersandToken) { expr(node.left); emit("DUP"); const end = label("and"); emit("JMPF", end); emit("POP"); expr(node.right); mark(end); return true; }
        if (k === ts.SyntaxKind.BarBarToken) { expr(node.left); emit("DUP"); const rhs = label("or"), end = label("oend"); emit("JMPF", rhs); emit("JMP", end); mark(rhs); emit("POP"); expr(node.right); mark(end); return true; }
        if (k === ts.SyntaxKind.QuestionQuestionToken) { expr(node.left); emit("DUP"); emit("ISNULLISH"); const end = label("nc"); emit("JMPF", end); emit("POP"); expr(node.right); mark(end); return true; }
        if (k === ts.SyntaxKind.CommaToken) { if (expr(node.left)) emit("POP"); return expr(node.right); }
        if (k === ts.SyntaxKind.AmpersandAmpersandEqualsToken) { assignTo(node.left, () => { expr(node.left); emit("DUP"); const e = label("ae"); emit("JMPF", e); emit("POP"); expr(node.right); mark(e); }); return false; }
        if (k === ts.SyntaxKind.BarBarEqualsToken) { assignTo(node.left, () => { expr(node.left); emit("DUP"); const r = label("oe"), e = label("oee"); emit("JMPF", r); emit("JMP", e); mark(r); emit("POP"); expr(node.right); mark(e); }); return false; }
        if (k === ts.SyntaxKind.QuestionQuestionEqualsToken) { assignTo(node.left, () => { expr(node.left); emit("DUP"); emit("ISNULLISH"); const e = label("nce"); emit("JMPF", e); emit("POP"); expr(node.right); mark(e); }); return false; }
        if (k === ts.SyntaxKind.InstanceOfKeyword) { if (!ts.isIdentifier(node.right) || !classes.has(node.right.text)) fail(node, "instanceof needs a class name"); expr(node.left); emit("ISA", node.right.text); return true; }
        const op = BINOP[k]; if (!op) fail(node, "unsupported operator");
        expr(node.left); expr(node.right); emit("BIN", op); return true;
      }
      if (ts.isPropertyAccessExpression(node)) { expr(node.expression); emit(getOp(node.name.text), node.name.text); return true; }
      if (ts.isElementAccessExpression(node)) { expr(node.expression); expr(node.argumentExpression); emit("INDEX"); return true; }
      if (ts.isObjectLiteralExpression(node)) {
        emit("NEWOBJ");
        for (const p of node.properties) {
          if (ts.isSpreadAssignment(p)) { expr(p.expression); emit("ASSIGNALL"); }
          else if (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name)) { emit("DUP"); expr(p.name.expression); expr(p.initializer); emit("SETINDEX"); } // {[k]: v}
          else if (ts.isPropertyAssignment(p)) { expr(p.initializer); emit("SETPROP", p.name.text); }
          else if (ts.isShorthandPropertyAssignment(p)) { readUse(p.name); emit("SETPROP", p.name.text); }
          else fail(p, "unsupported property");
        }
        return true;
      }
      if (ts.isArrayLiteralExpression(node)) { emit("NEWARR"); for (const el of node.elements) { if (ts.isSpreadElement(el)) { expr(el.expression); emit("APPENDALL"); } else { emit("DUP"); expr(el); emit("ARRPUSH"); } } return true; }
      if (ts.isCallExpression(node)) return call(node);
      fail(node, "unsupported expression");
    }

    function hof(objNode, kind, args) {                         // inline-compile map/filter/forEach/reduce
      const src = tempSlot(), fn = tempSlot(), i = tempSlot();
      expr(objNode); emit("STORE", src);
      expr(args[0]); emit("STORE", fn);
      let acc = null, outv = null;
      if (kind === "reduce") { if (args.length < 2) fail(objNode, "reduce needs an initial value"); acc = tempSlot(); expr(args[1]); emit("STORE", acc); }
      else if (kind !== "forEach") { outv = tempSlot(); emit("NEWARR"); emit("STORE", outv); }
      emit("PUSH", 0); emit("STORE", i);
      const loop = label("hof"), end = label("hofend"); mark(loop);
      emit("LOAD", i); emit("LOAD", src); emit("GETPROP", "length"); emit("BIN", "<"); emit("JMPF", end);
      const elemThenIndex = () => { emit("LOAD", src); emit("LOAD", i); emit("INDEX"); emit("LOAD", i); };
      if (kind === "map") { emit("LOAD", outv); emit("LOAD", fn); elemThenIndex(); emit("CALLV", 2); emit("ARRPUSH"); }
      else if (kind === "filter") { const skip = label("flt"); emit("LOAD", fn); elemThenIndex(); emit("CALLV", 2); emit("JMPF", skip); emit("LOAD", outv); emit("LOAD", src); emit("LOAD", i); emit("INDEX"); emit("ARRPUSH"); mark(skip); }
      else if (kind === "forEach") { emit("LOAD", fn); elemThenIndex(); emit("CALLV", 2); emit("POP"); }
      else if (kind === "reduce") { emit("LOAD", fn); emit("LOAD", acc); elemThenIndex(); emit("CALLV", 3); emit("STORE", acc); }
      emit("LOAD", i); emit("PUSH", 1); emit("BIN", "+"); emit("STORE", i); emit("JMP", loop); mark(end);
      if (kind === "forEach") return false;
      emit("LOAD", kind === "reduce" ? acc : outv); return true;
    }

    function superCall(supProg, supThisId, args) {
      const sup = classes.get(opts.superName); compileClass(opts.superName);
      const info = supProg === "__ctor__" ? sup.compiled.__ctor__ : sup.compiled[supProg];
      if (!info) fail(args.node || node, "super target not found: " + supProg);
      emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === sup.thisId ? ["E", capture(opts.thisId)] : provide(id))));
      args.forEach((a) => expr(a)); emit("CALLV", args.length); return true;
    }
    function promiseAll(arrNode) {                              // await each element sequentially -> array
      const src = tempSlot(), out = tempSlot(), i = tempSlot();
      expr(arrNode); emit("STORE", src); emit("NEWARR"); emit("STORE", out); emit("PUSH", 0); emit("STORE", i);
      const loop = label("pa"), end = label("paend"); mark(loop);
      emit("LOAD", i); emit("LOAD", src); emit("GETPROP", "length"); emit("BIN", "<"); emit("JMPF", end);
      emit("LOAD", out); emit("LOAD", src); emit("LOAD", i); emit("INDEX"); emit("AWAIT"); emit("ARRPUSH");
      emit("LOAD", i); emit("PUSH", 1); emit("BIN", "+"); emit("STORE", i); emit("JMP", loop); mark(end);
      emit("LOAD", out); return true;
    }
    function call(node) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Promise" && bindingOf.get(callee.expression) == null) {
        const m = callee.name.text, a = node.arguments;
        if (m === "resolve") { a[0] ? expr(a[0]) : emit("PUSH", undefined); return true; }   // identity
        if (m === "reject") { expr(a[0]); emit("MKREJECT"); return true; }
        if (m === "all") return promiseAll(a[0]);
        if (m === "race") { expr(a[0]); emit("PUSH", 0); emit("INDEX"); emit("AWAIT"); return true; } // sequential: first element
        fail(node, "unsupported Promise." + m);
      }
      if (callee.kind === ts.SyntaxKind.SuperKeyword) { if (!opts.superName) fail(node, "super outside a derived class"); return superCall("__ctor__", null, node.arguments); }
      if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.SuperKeyword) { if (!opts.superName) fail(node, "super outside a derived class"); return superCall(callee.name.text, null, node.arguments); }
      if (ts.isPropertyAccessExpression(callee)) {
        const resName = `${callee.expression.getText(sf)}.${callee.name.text}`;
        if (resourceSet.has(resName)) { node.arguments.forEach((a) => expr(a)); emit("RES", resName, node.arguments.length); return true; }
        const m = callee.name.text;
        if ((m === "next" || m === "return" || m === "throw") && node.arguments.length <= 1) { expr(callee.expression); node.arguments[0] ? expr(node.arguments[0]) : emit("PUSH", undefined); emit(m === "next" ? "GENNEXT" : m === "return" ? "GENRET" : "GENTHROW"); return true; } // it.next/return/throw(v)
        if (m === "push") { expr(callee.expression); expr(node.arguments[0]); emit("ARRPUSH"); return false; }
        if (HOF.has(m)) return hof(callee.expression, m, node.arguments);
        if (PLAIN_METHODS.has(m)) { expr(callee.expression); node.arguments.forEach((a) => expr(a)); emit("CALLM", m, node.arguments.length); return true; }
        return closureCall(callee, node.arguments); // user method (closure property)
      }
      if (ts.isIdentifier(callee) && bindingOf.get(callee) == null && !topFns.has(callee.text) && resourceSet.has(callee.text)) { node.arguments.forEach((a) => expr(a)); emit("RES", callee.text, node.arguments.length); return true; }
      if (ts.isIdentifier(callee) && callee.text === "BigInt" && bindingOf.get(callee) == null && !topFns.has(callee.text)) { expr(node.arguments[0]); emit("TOBIG"); return true; } // BigInt(x) conversion
      return closureCall(callee, node.arguments);
    }
    function closureCall(callee, args) {
      expr(callee);
      if (args.some((a) => ts.isSpreadElement(a))) { // variadic: build an args array, then CALLVS
        emit("NEWARR");
        for (const a of args) { if (ts.isSpreadElement(a)) { expr(a.expression); emit("APPENDALL"); } else { emit("DUP"); expr(a); emit("ARRPUSH"); } }
        emit("CALLVS");
      } else { args.forEach((a) => expr(a)); emit("CALLV", args.length); }
      return true;
    }

    function declOne(d) {
      const init = () => (d.initializer ? expr(d.initializer) : emit("PUSH", undefined)); // `let x;` -> undefined
      if (ts.isIdentifier(d.name)) { const id = bindingOf.get(d.name); if (boxed.has(id)) { emit("NEWOBJ"); init(); emit("SETPROP", "v"); emit("STORE", slotOf.get(id)); } else { init(); emit("STORE", slotOf.get(id)); } return; }
      if (!d.initializer) fail(d, "destructuring needs an initializer");
      const t = tempSlot(); expr(d.initializer); emit("STORE", t); bindPattern(d.name, t); // destructuring
    }

    function stmt(node) { const save = here; here = node; try { stmtInner(node); } finally { here = save; } }
    function stmtInner(node) {
      if (ts.isBlock(node)) return node.statements.forEach(stmt);
      if (ts.isFunctionDeclaration(node)) { // nested fn decl: fill the pre-created cell with the closure
        const childName = `${name}$${gen++}`; const child = compileFn(node, childName); out[childName] = child;
        emit("LOAD", slotOf.get(bindingOf.get(node.name))); emit("MAKECLOSURE", childName, child.freeIds.map(provide), !!node.asteriskToken); emit("SETPROP", "v"); emit("POP");
        return;
      }
      if (ts.isVariableStatement(node)) { for (const d of node.declarationList.declarations) declOne(d); return; }
      if (ts.isExpressionStatement(node)) { if (expr(node.expression)) emit("POP"); return; }
      if (ts.isSwitchStatement(node)) {
        const disc = tempSlot(); expr(node.expression); emit("STORE", disc);
        const end = label("swend"); const clauses = node.caseBlock.clauses;
        const at = clauses.map(() => label("sw")); let def = -1;
        clauses.forEach((cl, i) => { if (ts.isDefaultClause(cl)) { def = i; return; } emit("LOAD", disc); expr(cl.expression); emit("BIN", "==="); emit("NOT"); emit("JMPF", at[i]); }); // jump to clause if ===
        emit("JMP", def >= 0 ? at[def] : end);
        cf.push({ swtch: true, brk: end });
        clauses.forEach((cl, i) => { mark(at[i]); cl.statements.forEach(stmt); }); // fall-through is implicit
        cf.pop(); mark(end); return;
      }
      if (ts.isThrowStatement(node)) { expr(node.expression); emit("THROW"); return; }
      if (ts.isTryStatement(node)) {
        const cc = node.catchClause, fin = node.finallyBlock;
        // try BODY catch CATCH finally FIN  ==  try { try BODY catch CATCH } finally FIN.
        // The try/catch is registered on cf (so abrupt completions POPTRY it); the
        // finally is registered as a fin entry (so they run it on the way out too).
        const emitTryCatch = () => {
          if (!cc) { stmt(node.tryBlock); return; }
          const cat = label("catch"), done = label("trydone");
          emit("PUSHTRY", cat);
          cf.push({ tryPop: true }); stmt(node.tryBlock); cf.pop();   // handler live only in the try body
          emit("POPTRY"); emit("JMP", done);
          mark(cat);
          if (cc.variableDeclaration && ts.isIdentifier(cc.variableDeclaration.name)) bindStackTop(cc.variableDeclaration.name);
          else emit("POP");
          stmt(cc.block);                                            // catch body: handler already gone
          mark(done);
        };
        if (!fin) { emitTryCatch(); return; }
        const h = label("fin"), end = label("tryend"); const exc = tempSlot();
        emit("PUSHTRY", h);
        cf.push({ tryPop: true, fin }); emitTryCatch(); cf.pop();     // finally wraps the (try/)catch
        emit("POPTRY"); stmt(fin); emit("JMP", end);                 // normal completion -> run finally
        mark(h); emit("STORE", exc); stmt(fin); emit("LOAD", exc); emit("THROW"); // exception -> finally, re-throw
        mark(end); return;
      }
      if (ts.isReturnStatement(node)) {
        if (!node.expression) { unwind(-1); emit("PUSH", 0); emit("RET"); return; }
        expr(node.expression);
        if (crossedHasFin(-1)) { const t = tempSlot(); emit("STORE", t); unwind(-1); emit("LOAD", t); } // value computed before finally
        else unwind(-1);                                             // only POPTRYs; operand stack untouched
        emit("RET"); return;
      }
      if (ts.isIfStatement(node)) { expr(node.expression); const els = label("else"), end = label("end"); emit("JMPF", node.elseStatement ? els : end); stmt(node.thenStatement); if (node.elseStatement) { emit("JMP", end); mark(els); stmt(node.elseStatement); } mark(end); return; }
      if (ts.isLabeledStatement(node)) {
        const body = node.statement;
        if (ts.isWhileStatement(body) || ts.isForStatement(body) || ts.isForOfStatement(body) || ts.isForInStatement(body) || ts.isDoStatement(body)) { pendingLabel = node.label.text; stmt(body); return; }
        const end = label("lbl"); cf.push({ swtch: true, brk: end, name: node.label.text }); stmt(body); cf.pop(); mark(end); return; // labeled block: only `break label`
      }
      if (ts.isWhileStatement(node)) { const lbl = takeLabel(); const loop = label("loop"), end = label("end"); mark(loop); expr(node.expression); emit("JMPF", end); cf.push({ loop: true, brk: end, cont: loop, name: lbl }); stmt(node.statement); cf.pop(); emit("JMP", loop); mark(end); return; }
      if (ts.isDoStatement(node)) { const lbl = takeLabel(); const loop = label("loop"), step = label("step"), end = label("end"); mark(loop); cf.push({ loop: true, brk: end, cont: step, name: lbl }); stmt(node.statement); cf.pop(); mark(step); expr(node.expression); emit("JMPF", end); emit("JMP", loop); mark(end); return; }
      if (ts.isForStatement(node)) {
        const lbl = takeLabel();
        let perIter = []; // boxed `let` loop vars -> a fresh cell each iteration (closures capture per-iteration values)
        if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
          for (const d of node.initializer.declarations) declOne(d);
          for (const d of node.initializer.declarations) if (ts.isIdentifier(d.name)) { const id = bindingOf.get(d.name); if (boxed.has(id)) perIter.push(slotOf.get(id)); }
        } else if (node.initializer) { if (expr(node.initializer)) emit("POP"); }
        const loop = label("loop"), step = label("step"), end = label("end"); mark(loop);
        if (node.condition) { expr(node.condition); emit("JMPF", end); }
        cf.push({ loop: true, brk: end, cont: step, name: lbl }); stmt(node.statement); cf.pop();
        mark(step);
        for (const s of perIter) { emit("NEWOBJ"); emit("LOAD", s); emit("GETPROP", "v"); emit("SETPROP", "v"); emit("STORE", s); } // per-iteration env: copy cell AFTER body, BEFORE incrementor
        if (node.incrementor) { if (expr(node.incrementor)) emit("POP"); } emit("JMP", loop); mark(end); return;
      }
      if (ts.isForInStatement(node)) {
        const lbl = takeLabel(); const iter = tempSlot(), idx = tempSlot();
        expr(node.expression); emit("KEYS"); emit("STORE", iter); emit("PUSH", 0); emit("STORE", idx);
        const loop = label("loop"), step = label("step"), end = label("end"); mark(loop);
        emit("LOAD", idx); emit("LOAD", iter); emit("GETPROP", "length"); emit("BIN", "<"); emit("JMPF", end);
        const decl = node.initializer.declarations[0];
        emit("LOAD", iter); emit("LOAD", idx); emit("INDEX"); bindStackTop(decl.name);
        cf.push({ loop: true, brk: end, cont: step, name: lbl }); stmt(node.statement); cf.pop();
        mark(step); emit("LOAD", idx); emit("PUSH", 1); emit("BIN", "+"); emit("STORE", idx); emit("JMP", loop); mark(end); return;
      }
      if (ts.isForOfStatement(node)) {                            // iterator protocol: arrays AND generators/iterators
        const lbl = takeLabel(); const iter = tempSlot();
        expr(node.expression); emit("ITER"); emit("STORE", iter);
        const loop = label("loop"), body = label("body"), step = label("step"), end = label("end"); mark(loop);
        emit("LOAD", iter); emit("ITERNEXT");                     // -> value, done
        emit("JMPF", body); emit("POP"); emit("JMP", end);        // done -> drop value, exit
        mark(body);                                               // stack: [value]
        if (node.awaitModifier) emit("AWAIT");                    // `for await`: await each value (identity for a plain value)
        const decl = node.initializer.declarations[0];
        if (ts.isIdentifier(decl.name)) bindStackTop(decl.name); else { const t = tempSlot(); emit("STORE", t); bindPattern(decl.name, t); }
        cf.push({ loop: true, brk: end, cont: step, name: lbl }); stmt(node.statement); cf.pop();
        mark(step); emit("JMP", loop); mark(end); return;         // ITERNEXT advances the iterator
      }
      if (ts.isBreakStatement(node)) { const i = node.label ? targetForLabel(node.label.text, "break") : targetFor("break"); if (i < 0) fail(node, "break has no target"); unwind(i); emit("JMP", cf[i].brk); return; }
      if (ts.isContinueStatement(node)) { const i = node.label ? targetForLabel(node.label.text, "continue") : targetFor("continue"); if (i < 0) fail(node, "continue has no target"); unwind(i); emit("JMP", cf[i].cont); return; }
      fail(node, "unsupported statement");
    }

    if (opts.emitBody) { opts.emitBody({ emit, expr, tempSlot, label, mark, provide }); const { code, pos } = assemble(); return { nlocals: topSlot, code, pos, freeIds: envIds }; } // synthetic class-object builder

    // --- prologue: rest param, default params, box captured params, fields, hoist nested fn decls
    for (const p of node.parameters) if (p.dotDotDotToken && ts.isIdentifier(p.name)) emit("GATHERREST", slotOf.get(bindingOf.get(p.name)));
    for (const p of node.parameters) if (p.initializer && ts.isIdentifier(p.name)) { const s = slotOf.get(bindingOf.get(p.name)); const skip = label("dflt"); emit("LOAD", s); emit("PUSH", undefined); emit("BIN", "==="); emit("JMPF", skip); expr(p.initializer); emit("STORE", s); mark(skip); }
    for (const p of node.parameters) if (ts.isIdentifier(p.name) && boxed.has(bindingOf.get(p.name))) { const s = slotOf.get(bindingOf.get(p.name)); emit("NEWOBJ"); emit("LOAD", s); emit("SETPROP", "v"); emit("STORE", s); }
    if (opts.fieldInits) for (const f of opts.fieldInits) { emit("LOADENV", capture(opts.thisId)); expr(f.init); emit("SETPROP", f.name); emit("POP"); } // class field initializers, with `this` bound
    // Pre-create empty cells for nested fn decls (boxed) so they're live bindings
    // before their lexical definition (recursion + capture timing). Filled below.
    const findFnDecls = (n, acc) => { if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return; if (ts.isFunctionDeclaration(n) && n !== node) { acc.push(n); return; } ts.forEachChild(n, (c) => findFnDecls(c, acc)); };
    const fnDecls = []; if (node.body) ts.forEachChild(node.body, (c) => findFnDecls(c, fnDecls));
    for (const fd of fnDecls) { emit("NEWOBJ"); emit("STORE", slotOf.get(bindingOf.get(fd.name))); }

    if (node.body && ts.isBlock(node.body)) node.body.statements.forEach(stmt);
    else { expr(node.body); emit("RET"); }
    const last = asm[asm.length - 1];
    if (!(Array.isArray(last) && last[0] === "RET")) { emit("PUSH", 0); emit("RET"); }
    const { code, pos } = assemble();
    return { nlocals: topSlot, code, pos, freeIds: envIds };
  }

  compileTop(entry);
  // Generate class-object builders now that every class is fully compiled (so
  // static-method freeIds are known). Fixpoint: a field init may reference more classes.
  const builtBuilders = new Set();
  while ([...neededBuilders].some((c) => !builtBuilders.has(c))) {
    for (const cname of [...neededBuilders]) {
      if (builtBuilders.has(cname)) continue; builtBuilders.add(cname);
      out[`%${cname}`] = compileFn({ parameters: [] }, `%${cname}`, { emitBody: (ctx) => buildClassObjectBody(cname, ctx) });
    }
  }
  const frag = {};
  for (const [k, v] of Object.entries(out)) frag[k] = { nlocals: v.nlocals, code: v.code, pos: v.pos };
  return frag;
}

export function loadModule(PROGRAM, source, opts) { const frag = compileModule(source, opts); for (const [k, v] of Object.entries(frag)) PROGRAM[k] = v; return frag; }

export function describeContinuation(PROGRAM, frames) {
  return frames.map((f, i) => { const at = Math.max(0, f.ip - 1); const loc = PROGRAM[f.fn] && PROGRAM[f.fn].pos ? PROGRAM[f.fn].pos[at] : null; return { depth: frames.length - 1 - i, fn: f.fn, loc }; });
}
