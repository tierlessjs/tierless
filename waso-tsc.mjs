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

// A ts.Program over an in-memory file set, so the frontend has a real type checker
// (cross-module symbol resolution for decorator metadata) and can follow imports.
// noLib keeps it fast — we never read lib.d.ts; builtin types are resolved
// syntactically, and the checker is only asked to resolve user symbols across modules.
const PROGRAM_OPTS = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noLib: true, allowJs: true, experimentalDecorators: true, noResolve: false };
function makeProgram(files) { // files: Map<absolutePath, source>
  const host = {
    getSourceFile(name, lang) { const t = files.has(name) ? files.get(name) : ts.sys.readFile(name); return t !== undefined ? ts.createSourceFile(name, t, lang, true) : undefined; },
    getDefaultLibFileName() { return "/lib.d.ts"; }, writeFile() {}, getCurrentDirectory() { return "/"; },
    getDirectories(p) { return ts.sys.getDirectories ? ts.sys.getDirectories(p) : []; },
    getCanonicalFileName(f) { return f; }, useCaseSensitiveFileNames() { return true; }, getNewLine() { return "\n"; },
    fileExists(name) { return files.has(name) || ts.sys.fileExists(name); },
    readFile(name) { return files.has(name) ? files.get(name) : ts.sys.readFile(name); },
  };
  return ts.createProgram([...files.keys()], PROGRAM_OPTS, host);
}

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
const HOF = new Set(["map", "filter", "forEach", "reduce", "find", "findIndex", "some", "every"]); // callback is a Waso closure -> inline-compiled
const GLOBAL_OBJS = new Set(["Math", "JSON", "Object", "Array", "Number", "String", "Boolean", "console", "Date", "Symbol"]); // host stdlib (match waso-heap GLOBALS)
const GLOBAL_CALLS = new Set(["parseInt", "parseFloat", "isNaN", "isFinite", "Number", "String", "Boolean", "Symbol"]); // callable globals
const CTOR_GLOBALS = new Set(["Map", "Set", "WeakMap", "WeakSet", "Date", "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "RegExp"]); // host constructors via `new` (match waso-heap CTORS)
const ERROR_CTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"]); // extendable host error bases
const BUILTIN_CTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "Array", "Map", "Set", "WeakMap", "WeakSet", "Date", "RegExp", "Object", "Number", "String", "Boolean", "Promise"]); // valid `instanceof` RHS (match HOSTCTORS in waso-core)
const PLAIN_METHODS = new Set(["slice", "indexOf", "lastIndexOf", "includes", "join", "concat", "toUpperCase",
  "toLowerCase", "split", "trim", "trimStart", "trimEnd", "charAt", "charCodeAt", "substring", "substr", "repeat",
  "padStart", "padEnd", "startsWith", "endsWith", "replace", "replaceAll", "toFixed", "at",
  "test", "exec", "match", "matchAll", "search", "reverse", "fill", "toString", "valueOf", "flat"]); // host intrinsics (incl. regex)
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
  const usesArguments = new Map();            // non-arrow fnNode -> its synthetic `arguments` binding id
  const isPropName = (node) => { const p = node.parent; return p && ((ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isParameter(p) && p.name === node) || (ts.isVariableDeclaration(p) && p.name === node) || (ts.isBindingElement(p) && p.name === node) || (isFnLike(p) && p.name === node)); };
  const isWrite = (node) => { const p = node.parent; if (!p) return false; if (ts.isBinaryExpression(p) && p.left === node && (p.operatorToken.kind === ts.SyntaxKind.EqualsToken || COMPOUND.has(p.operatorToken.kind))) return true; if ((ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p)) && p.operand === node) return true; return false; };
  const isLexical = (flags) => !!(flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));

  const scopes = [];                          // { kind:"fn"|"block", names:Map, fnNode }
  const curFn = () => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].kind === "fn") return scopes[i].fnNode; return null; };
  const declareIn = (scope, nameNode) => { const id = next++; scope.names.set(nameNode.text, id); bindingOf.set(nameNode, id); declFn.set(id, scope.fnNode); if (!bindingsByFn.has(scope.fnNode)) bindingsByFn.set(scope.fnNode, []); bindingsByFn.get(scope.fnNode).push(id); return id; };
  const reserveSlot = (scope) => { const id = next++; declFn.set(id, scope.fnNode); if (!bindingsByFn.has(scope.fnNode)) bindingsByFn.set(scope.fnNode, []); bindingsByFn.get(scope.fnNode).push(id); }; // a positional slot with no name (a destructuring param's raw arg)
  // function-scoped names: params + `var`s + nested function-declaration names (don't descend into nested fns)
  const hoistFn = (fnNode, scope) => {
    // One slot PER PARAMETER POSITION first (calling convention: arg i -> slot i), so a
    // destructuring param's raw arg keeps slot i and its inner names get later slots.
    fnNode.parameters.forEach((p) => { if (ts.isIdentifier(p.name)) declareIn(scope, p.name); else reserveSlot(scope); });
    fnNode.parameters.forEach((p) => { if (!ts.isIdentifier(p.name)) { const ids = []; patternIds(p.name, ids); ids.forEach((nm) => declareIn(scope, nm)); } });
    const rec = (n) => {
      if (n !== fnNode && isFnLike(n)) { if (ts.isFunctionDeclaration(n) && n.name) forceBox.add(declareIn(scope, n.name)); return; } // nested fn decl name -> live binding (recursion + capture timing)
      const isVarList = (l) => l && ts.isVariableDeclarationList(l) && !isLexical(l.flags);
      if (ts.isVariableStatement(n) && isVarList(n.declarationList)) for (const d of n.declarationList.declarations) { const ids = []; patternIds(d.name, ids); ids.forEach((nm) => declareIn(scope, nm)); }
      if ((ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) && isVarList(n.initializer)) for (const d of n.initializer.declarations) { const ids = []; patternIds(d.name, ids); ids.forEach((nm) => declareIn(scope, nm)); }
      ts.forEachChild(n, rec);
    };
    if (fnNode.body) rec(fnNode.body);
    // `arguments`: a non-arrow function that references it (directly or in a nested
    // arrow) gets a synthetic binding; the prologue snapshots the passed args.
    if (!ts.isArrowFunction(fnNode)) {
      let uses = false;
      const scan = (n) => { if (n !== fnNode && isFnLike(n) && !ts.isArrowFunction(n)) return; if (ts.isIdentifier(n) && n.text === "arguments" && !isPropName(n)) uses = true; ts.forEachChild(n, scan); };
      if (fnNode.body) ts.forEachChild(fnNode.body, scan);
      if (uses) { const id = next++; scope.names.set("arguments", id); declFn.set(id, fnNode); bindingsByFn.get(fnNode).push(id); usesArguments.set(fnNode, id); }
    }
  };
  // block-scoped names declared directly in a block: let/const + class (functions are hoisted to the fn scope)
  const hoistBlock = (statements, scope) => { for (const st of statements) { if (ts.isVariableStatement(st) && isLexical(st.declarationList.flags)) for (const d of st.declarationList.declarations) { const ids = []; patternIds(d.name, ids); ids.forEach((nm) => declareIn(scope, nm)); } else if (ts.isClassDeclaration(st) && st.name) declareIn(scope, st.name); } };
  const headerLets = (init, scope) => { if (init && ts.isVariableDeclarationList(init) && isLexical(init.flags)) for (const d of init.declarations) { const ids = []; patternIds(d.name, ids); ids.forEach((nm) => declareIn(scope, nm)); } };

  const walk = (node) => {
    if (node == null) return;
    if (isFnLike(node)) {
      if (node.name && ts.isComputedPropertyName(node.name)) walk(node.name.expression); // computed method/accessor key resolves in the ENCLOSING scope
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
  // Module scope: top-level let/const/var are module bindings (stored per tier via
  // MGET/MSET, not frame slots), so functions can read/write them.
  const moduleBindings = new Map(); // bindingId -> name
  const mscope = { kind: "module", names: new Map(), fnNode: null };
  scopes.push(mscope);
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) { const ids = []; patternIds(d.name, ids); for (const nm of ids) { const id = next++; mscope.names.set(nm.text, id); bindingOf.set(nm, id); declFn.set(id, null); moduleBindings.set(id, nm.text); } }
  }
  sf.statements.forEach(walk);
  scopes.pop();
  // Box every captured binding (cell shared by reference): handles mutation AND
  // capture-before-initialization (recursive `const f = () => f()`, mutual recursion).
  const boxed = new Set([...captured].filter((id) => !moduleBindings.has(id)));
  for (const id of forceBox) boxed.add(id);
  return { bindingOf, declFn, bindingsByFn, boxed, usesArguments, moduleBindings };
}

// Compile one module's source file into the shared `out`. `prefix` namespaces every
// global name (out keys, module-binding registry keys, class unames) so modules don't
// collide; the entry module uses "" for back-compat. `importResolve(idNode)` maps an
// imported identifier to another module's already-namespaced global ref. Exports the
// module's own top-level decls into `declRef` so other modules can resolve them.
function compileInto(sf, checker, { resources = [], entry = null, prefix = "", out, importResolve = () => null, sharedClasses = null, initName = "%moduleinit" }) {
  const G = (n) => prefix + n; // global name for this module
  const topClassByName = new Map(); // bare class name -> uname (this module), for classNameOf
  const topFns = new Map();
  const generatorFns = new Set();   // top-level `function*` names -> a call makes an iterator, not a normal call
  for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name) { topFns.set(s.name.text, s); if (s.asteriskToken) generatorFns.add(s.name.text); }
  // Classes: an instance is an object whose method properties are closures
  // capturing `this`; the constructor (with field inits prepended) runs at `new`.
  const resourceSet = new Set(resources);
  const { bindingOf, bindingsByFn, boxed, usesArguments, moduleBindings } = resolveBindings(sf);
  for (const [id, nm] of moduleBindings) moduleBindings.set(id, G(nm)); // namespace the per-tier module-binding registry keys
  const classes = sharedClasses || new Map(); // unique (namespaced) class name -> record; SHARED across a program so a derived class can reference an imported base (top-level class methods capture only module bindings + `this`, so the base's own module compiles them)
  const classOfBinding = new Map();  // bindingId -> unique class name (LOCAL classes, which have a block binding)
  const accessorNames = new Set();   // property names that are a get/set in SOME class/object-literal -> read/write uses the accessor-aware op
  const objLiteralThis = new Map();  // object-literal node -> synthetic thisId (for methods/getters that use `this`)
  let thisCounter = -1, classUid = 0;
  { const scan = (n) => { if ((ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) accessorNames.add(n.name.text); ts.forEachChild(n, scan); }; scan(sf); } // pre-scan ALL accessor names (class + object-literal)
  const decof = (node) => ((ts.canHaveDecorators(node) ? ts.getDecorators(node) : null) || []).map((dn) => dn.expression); // decorator expression nodes on a declaration
  const collectClass = (s) => {
    const isStatic = (mem) => (mem.modifiers || []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
    const named = (n) => (n && (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) ? n.text : null); // `#x` private fields/methods -> "#x" key
    const fields = [], methods = [], accessors = [], sfields = [], smethods = [], saccessors = [], cmethods = [], pdecorators = []; let ctor = null;
    const paramsOf = (mem, key) => (mem.parameters || []).forEach((p, i) => { const ds = decof(p); if (ds.length) pdecorators.push({ key, index: i, exprs: ds, static: isStatic(mem) }); }); // @Inject() x: T -> dec(target, key, i)
    for (const mem of s.members) {
      const st = isStatic(mem), nm = named(mem.name), dec = decof(mem);
      if (ts.isMethodDeclaration(mem) && !nm && mem.name && ts.isComputedPropertyName(mem.name)) cmethods.push({ keyExpr: mem.name.expression, node: mem, static: st }); // [k](){} / [Symbol.iterator](){}
      else if (ts.isPropertyDeclaration(mem) && mem.initializer && nm) (st ? sfields : fields).push({ name: nm, init: mem.initializer, decorators: dec });
      else if (ts.isPropertyDeclaration(mem) && nm && dec.length) (st ? sfields : fields).push({ name: nm, init: null, decorators: dec }); // decorated field with no initializer (still needs the property decorator to run)
      else if (ts.isMethodDeclaration(mem) && nm) { (st ? smethods : methods).push({ name: nm, node: mem, decorators: dec }); paramsOf(mem, nm); }
      else if (ts.isGetAccessorDeclaration(mem) && nm) { (st ? saccessors : accessors).push({ name: nm, kind: "get", node: mem, decorators: dec }); accessorNames.add(nm); paramsOf(mem, nm); }
      else if (ts.isSetAccessorDeclaration(mem) && nm) { (st ? saccessors : accessors).push({ name: nm, kind: "set", node: mem, decorators: dec }); accessorNames.add(nm); paramsOf(mem, nm); }
      else if (ts.isConstructorDeclaration(mem) && mem.body) { ctor = mem; paramsOf(mem, undefined); }
    }
    const extendsId = (s.heritageClauses || []).filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword).flatMap((h) => h.types).map((t) => t.expression).find((e) => ts.isIdentifier(e)) || null;
    const top = s.parent === sf;
    const uname = top ? G(s.name.text) : G(`${s.name.text}$c${classUid++}`); // top-level keeps its (namespaced) name; local gets a unique one
    if (top) topClassByName.set(s.name.text, uname);
    const decos = (ts.canHaveDecorators(s) ? ts.getDecorators(s) : null) || []; // @Injectable()/@Component()/... (legacy: run on the class at module load)
    const hasMemberDec = pdecorators.length || [...fields, ...sfields, ...methods, ...smethods, ...accessors, ...saccessors].some((x) => x.decorators && x.decorators.length);
    classes.set(uname, { name: uname, thisId: thisCounter--, staticThisId: thisCounter--, fields, methods, accessors, sfields, smethods, saccessors, cmethods, ctor, superName: null, _ext: extendsId, decorators: decos.map((d) => d.expression), pdecorators, hasMemberDec, topLevel: top, declNode: s });
    if (s.name && bindingOf.has(s.name)) classOfBinding.set(bindingOf.get(s.name), uname);
  };
  { const w = (n) => { if (ts.isClassDeclaration(n) && n.name) collectClass(n); ts.forEachChild(n, w); }; w(sf); } // classes ANYWHERE (top-level + local)
  const classNameOf = (idNode) => { const b = bindingOf.get(idNode); if (b != null && classOfBinding.has(b)) return classOfBinding.get(b); if (topClassByName.has(idNode.text)) return topClassByName.get(idNode.text); return null; };
  for (const rec of classes.values()) { if (rec.superName || rec.hostSuper || !rec._ext) continue; const e = rec._ext; const imp = importResolve(e); const userSuper = (bindingOf.has(e) && classOfBinding.has(bindingOf.get(e))) ? classOfBinding.get(bindingOf.get(e)) : (topClassByName.has(e.text) ? topClassByName.get(e.text) : (imp && imp.kind === "class" ? imp.uname : null)); if (userSuper) rec.superName = userSuper; else if (bindingOf.get(e) == null && ERROR_CTORS.has(e.text)) rec.hostSuper = e.text; } // supers: local class, imported class, or a host error base
  let gen = 0;
  const neededBuilders = new Set();   // classes whose class-object builder (%Name) must be generated
  const lineColOf = (node) => { if (!node || !node.getStart) return null; const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf)); return { file: sf.fileName, line: lc.line + 1, col: lc.character + 1, text: node.getText(sf).replace(/\s+/g, " ").slice(0, 32) }; };
  // The class object: a singleton (statics live on it), built-or-returned by a
  // 0-arg builder fn, cached per tier (CLSGET/CLSPUT). Emitted as raw IR via
  // compileFn's emitBody hook so static-field initializers reuse expr().
  // Build an instance up to (but not including) the constructor call: a fresh object
  // tagged with the class chain, instance methods (decorated -> shared closure),
  // accessors, and computed methods. Shared by the inline `new ClassName` lowering and
  // the per-class %new_<cname> builder that powers dynamic `new C(...)` / Reflect.construct.
  const emitInstanceAssembly = (cname, { emit, expr, tempSlot, provide, classObject }) => {
    const rec = compileClass(cname);
    const chain = []; for (let c = rec; c; c = c.superName ? compileClass(c.superName) : null) chain.unshift(c); // base-first
    const inst = tempSlot(); emit("NEWOBJ"); emit("STORE", inst);
    const hostBase = chain[0].hostSuper;
    const classNames = (hostBase ? (hostBase === "Error" ? ["Error"] : ["Error", hostBase]) : []).concat(chain.map((c) => c.name));
    emit("LOAD", inst); emit("PUSH", classNames); emit("SETHIDDEN", "__class__"); emit("POP");
    for (const cls of chain) for (const m of cls.methods) {
      if (m.decorators && m.decorators.length) { emit("LOAD", inst); classObject(cls.name); emit("GETPROP", `__dm_${m.name}`); emit("SETHIDDEN", m.name); emit("POP"); continue; }
      const info = cls.compiled[m.name]; emit("LOAD", inst); emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === cls.thisId ? ["L", inst] : provide(id))), !!m.node.asteriskToken); emit("SETHIDDEN", m.name); emit("POP");
    }
    const accs = new Map();
    for (const cls of chain) { const byName = new Map(); for (const a of cls.accessors) { const e = byName.get(a.name) || {}; e[a.kind] = { cls, info: cls.compiled[`${a.kind} ${a.name}`] }; byName.set(a.name, e); } for (const [n, e] of byName) accs.set(n, e); }
    if (accs.size) {
      const tbl = tempSlot(); emit("NEWOBJ"); emit("STORE", tbl);
      for (const [aname, e] of accs) {
        const ent = tempSlot(); emit("NEWOBJ"); emit("STORE", ent);
        for (const kind of ["get", "set"]) { const s = e[kind]; if (!s) continue; emit("LOAD", ent); emit("MAKECLOSURE", s.info.prog, s.info.freeIds.map((id) => (id === s.cls.thisId ? ["L", inst] : provide(id)))); emit("SETPROP", kind); emit("POP"); }
        emit("LOAD", tbl); emit("LOAD", ent); emit("SETPROP", aname); emit("POP");
      }
      emit("LOAD", inst); emit("LOAD", tbl); emit("SETHIDDEN", "__accessors__"); emit("POP");
    }
    for (const cls of chain) for (const m of cls.cmethods) if (!m.static) { emit("LOAD", inst); expr(m.keyExpr); emit("MAKECLOSURE", m.compiled.prog, m.compiled.freeIds.map((id) => (id === cls.thisId ? ["L", inst] : provide(id))), m.compiled.gen); emit("SETINDEX"); }
    return { rec, inst };
  };
  // %new_<cname>(argsArray): the class as a callable constructor — assemble the instance,
  // run the ctor with the args spread, return it. Stored on the class object as
  // __construct__ so `new C(...)` on a runtime class value and Reflect.construct work.
  const buildConstructBody = (cname, ctx) => {
    const { emit, provide } = ctx;
    const { rec, inst } = emitInstanceAssembly(cname, ctx);
    const info = rec.compiled.__ctor__; emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === rec.thisId ? ["L", inst] : provide(id)))); emit("LOAD", 0); emit("CALLVS"); emit("POP"); // ctor(...argsArray)
    emit("LOAD", inst); emit("RET");
  };
  const buildClassObjectBody = (cname, { emit, expr, tempSlot, label, mark, provide, emitTypeRef }) => {
    const rec = compileClass(cname);
    const chain = []; for (let c = rec; c; c = c.superName ? compileClass(c.superName) : null) chain.unshift(c); // base-first; derived overrides
    const ready = label("clsr");
    emit("CLSGET", cname); emit("DUP"); emit("ISNULLISH"); emit("JMPF", ready); emit("POP"); // cached -> return it
    const co = tempSlot(); emit("NEWOBJ"); emit("STORE", co);
    emit("LOAD", co); emit("PUSH", chain.map((c) => c.name)); emit("SETPROP", "__class__"); emit("POP");
    emit("LOAD", co); emit("PUSH", true); emit("SETHIDDEN", "__classobj__"); emit("POP"); // marks the class object (callable) so `typeof ClassName` is "function" while instances stay "object"
    emit("LOAD", co); emit("LOAD", co); emit("SETHIDDEN", "prototype"); emit("POP"); // Class.prototype aliases the class object (we collapse prototype/constructor): instance-member decorator targets and metadata land here
    if (rec.topLevel) { emit("LOAD", co); emit("MAKECLOSURE", `%new_${cname}`, []); emit("SETHIDDEN", "__construct__"); emit("POP"); } // callable constructor for dynamic `new C(...)` / Reflect.construct
    emit("LOAD", co); emit("CLSPUT", cname); emit("POP"); // cache BEFORE static methods/inits so a self-reference (e.g. `static b = C.a+1`) resolves to the in-progress object instead of re-entering the builder
    for (const cls of chain) for (const m of cls.smethods) { const info = cls.compiled[`static ${m.name}`]; emit("LOAD", co); emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === cls.staticThisId ? ["L", co] : provide(id))), !!m.node.asteriskToken); emit("SETPROP", m.name); emit("POP"); }
    for (const cls of chain) for (const fld of cls.sfields) { emit("LOAD", co); expr(fld.init); emit("SETPROP", fld.name); emit("POP"); } // init runs code
    const accs = new Map();
    for (const cls of chain) { const byName = new Map(); for (const a of cls.saccessors) { const e = byName.get(a.name) || {}; e[a.kind] = { cls, info: cls.compiled[`static ${a.kind} ${a.name}`] }; byName.set(a.name, e); } for (const [n, e] of byName) accs.set(n, e); } // derived shadows base per name
    if (accs.size) {
      const tbl = tempSlot(); emit("NEWOBJ"); emit("STORE", tbl);
      for (const [aname, e] of accs) {
        const ent = tempSlot(); emit("NEWOBJ"); emit("STORE", ent);
        for (const kind of ["get", "set"]) { const s = e[kind]; if (!s) continue; emit("LOAD", ent); emit("MAKECLOSURE", s.info.prog, s.info.freeIds.map((id) => (id === s.cls.staticThisId ? ["L", co] : provide(id)))); emit("SETPROP", kind); emit("POP"); }
        emit("LOAD", tbl); emit("LOAD", ent); emit("SETPROP", aname); emit("POP");
      }
      emit("LOAD", co); emit("LOAD", tbl); emit("SETPROP", "__accessors__"); emit("POP");
    }
    for (const cls of chain) for (const m of cls.cmethods) if (m.static) { emit("LOAD", co); expr(m.keyExpr); emit("MAKECLOSURE", m.compiled.prog, m.compiled.freeIds.map((id) => (id === cls.staticThisId ? ["L", co] : provide(id))), m.compiled.gen); emit("SETINDEX"); }
    // --- member decorators (legacy): target = class object; run once when it is built ---
    // A method decorator gets a {value, writable, enumerable, configurable} descriptor;
    // its (possibly replaced) `value` becomes the method. Instance methods are shared
    // (dynamic `this`) and stashed at __dm_<name> for `new` to pick up; static methods
    // are replaced on the class object directly. Property/parameter decorators run for
    // their side effects (metadata). Decorators apply bottom-up.
    const decorateMethod = (m, isStatic) => {
      const info = rec.compiled[isStatic ? `static ${m.name}` : m.name]; const tid = isStatic ? rec.staticThisId : rec.thisId;
      const dt = tempSlot(); emit("NEWOBJ"); emit("STORE", dt);
      emit("LOAD", dt); emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === tid ? ["L", co] : provide(id))), !!m.node.asteriskToken); emit("SETPROP", "value"); emit("POP");
      for (const [k, v] of [["writable", true], ["enumerable", false], ["configurable", true]]) { emit("LOAD", dt); emit("PUSH", v); emit("SETPROP", k); emit("POP"); }
      for (let i = m.decorators.length - 1; i >= 0; i--) { // dec(target, key, descriptor) -> a returned descriptor replaces dt; else dt was mutated in place
        expr(m.decorators[i]); emit("LOAD", co); emit("PUSH", m.name); emit("LOAD", dt); emit("CALLV", 3);
        const set = label("dm"), done = label("dmd"); emit("DUP"); emit("ISNULLISH"); emit("JMPF", set); emit("POP"); emit("JMP", done); mark(set); emit("STORE", dt); mark(done);
      }
      emit("LOAD", co); emit("LOAD", dt); emit("GETPROP", "value"); emit(isStatic ? "SETPROP" : "SETHIDDEN", isStatic ? m.name : `__dm_${m.name}`); emit("POP"); // static: replace on class; instance: stash for `new`
    };
    for (const m of rec.methods) if (m.decorators && m.decorators.length) decorateMethod(m, false);
    for (const m of rec.smethods) if (m.decorators && m.decorators.length) decorateMethod(m, true);
    const sideEffect = (decs, args) => { for (let i = decs.length - 1; i >= 0; i--) { expr(decs[i]); args(); emit("POP"); } };
    for (const fld of [...rec.fields, ...rec.sfields]) if (fld.decorators && fld.decorators.length) sideEffect(fld.decorators, () => { emit("LOAD", co); emit("PUSH", fld.name); emit("CALLV", 2); }); // @Column/@Input: dec(target, key)
    for (const a of [...rec.accessors, ...rec.saccessors]) if (a.decorators && a.decorators.length) sideEffect(a.decorators, () => { emit("LOAD", co); emit("PUSH", a.name); emit("PUSH", undefined); emit("CALLV", 3); }); // accessor decorator: dec(target, key, desc) — side effects only (no replacement)
    for (const pd of rec.pdecorators) sideEffect(pd.exprs, () => { emit("LOAD", co); emit("PUSH", pd.key); emit("PUSH", pd.index); emit("CALLV", 3); }); // @Inject(): dec(target, key, paramIndex)
    // emitDecoratorMetadata: a decorated class carries design:paramtypes (its ctor's
    // parameter types) so a DI container can resolve constructor injection by type.
    if (rec.decorators && rec.decorators.length && rec.ctor) { // TS emits this only for a class with an explicit constructor
      emit("PUSH", "design:paramtypes"); emit("NEWARR");
      for (const p of rec.ctor.parameters) { emit("DUP"); emitTypeRef(p.type); emit("ARRPUSH"); }
      emit("LOAD", co); emit("PUSH", undefined); emit("DEFMETA"); emit("POP"); // defineMetadata("design:paramtypes", [...], classObject)
    }
    emit("LOAD", co); emit("RET");                                 // already cached above; return it
    mark(ready); emit("RET");                                       // cached value already on stack
  };
  // Implicit constructor (when a class declares none): super(...args) if derived,
  // then own field inits. So `super()` always has a target and `new` always calls a ctor.
  const buildImplicitCtor = (rec, { emit, expr, provide, capture }) => {
    if (rec.superName) { const sup = classes.get(rec.superName); compileClass(rec.superName); const info = sup.compiled.__ctor__; emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === sup.thisId ? ["E", capture(rec.thisId)] : provide(id)))); emit("ARGUMENTS"); emit("CALLVS"); emit("POP"); }
    else if (rec.hostSuper) { emit("LOADENV", capture(rec.thisId)); emit("PUSH", rec.hostSuper); emit("SETHIDDEN", "name"); emit("POP"); emit("LOADENV", capture(rec.thisId)); emit("ARGUMENTS"); emit("PUSH", 0); emit("INDEX"); emit("SETHIDDEN", "message"); emit("POP"); } // implicit Error subclass ctor: name + message(args[0])
    for (const f of rec.fields) { emit("LOADENV", capture(rec.thisId)); expr(f.init); emit("SETPROP", f.name); emit("POP"); }
    emit("PUSH", undefined); emit("RET");
  };
  const compileTop = (name) => { const k = G(name); if (k in out) return; out[k] = null; out[k] = compileFn(topFns.get(name), k); }; // namespaced program key
  const compileClass = (cname) => {
    const rec = classes.get(cname); if (rec.compiled) return rec;
    if (rec.superName) compileClass(rec.superName);
    rec.compiled = {};
    const o = { thisId: rec.thisId, superName: rec.superName, hostSuper: rec.hostSuper };
    const cprog = `${cname}#constructor`; // ctor FIRST so a method body that does `new ThisClass()` finds it mid-compile
    if (rec.ctor) { const c = compileFn(rec.ctor, cprog, { ...o, fieldInits: rec.fields, ctorOf: cname }); out[cprog] = c; rec.compiled.__ctor__ = { prog: cprog, freeIds: c.freeIds }; }
    else { const c = compileFn({ parameters: [] }, cprog, { ...o, ctorOf: cname, emitBody: (ctx) => buildImplicitCtor(rec, ctx) }); out[cprog] = c; rec.compiled.__ctor__ = { prog: cprog, freeIds: c.freeIds }; } // synthesized (this/super available for field inits)
    for (const m of rec.methods) { const prog = `${cname}#${m.name}`; const c = compileFn(m.node, prog, o); out[prog] = c; rec.compiled[m.name] = { prog, freeIds: c.freeIds }; }
    for (const a of rec.accessors) { const prog = `${cname}#${a.kind} ${a.name}`; const c = compileFn(a.node, prog, o); out[prog] = c; rec.compiled[`${a.kind} ${a.name}`] = { prog, freeIds: c.freeIds }; }
    const so = { thisId: rec.staticThisId, superName: rec.superName }; // static `this` = the class object
    for (const m of rec.smethods) { const prog = `${cname}#static ${m.name}`; const c = compileFn(m.node, prog, so); out[prog] = c; rec.compiled[`static ${m.name}`] = { prog, freeIds: c.freeIds }; }
    for (const a of rec.saccessors) { const prog = `${cname}#static ${a.kind} ${a.name}`; const c = compileFn(a.node, prog, so); out[prog] = c; rec.compiled[`static ${a.kind} ${a.name}`] = { prog, freeIds: c.freeIds }; }
    rec.cmethods.forEach((m, i) => { const prog = `${cname}#computed${i}`; const c = compileFn(m.node, prog, m.static ? so : o); out[prog] = c; m.compiled = { prog, freeIds: c.freeIds, gen: !!m.node.asteriskToken }; }); // computed-name methods (key built at construction)
    return rec;
  };

  function compileFn(node, name, opts = {}) {
    const ids = bindingsByFn.get(node) || []; // synthetic builders (emitBody) have no bindings
    const slotOf = new Map(); ids.forEach((id, i) => slotOf.set(id, i));
    let topSlot = ids.length; const tempSlot = () => topSlot++;
    const envIdx = new Map(); const envIds = [];
    const capture = (id) => { if (!envIdx.has(id)) { envIdx.set(id, envIds.length); envIds.push(id); } return envIdx.get(id); };
    const provide = (id) => (slotOf.has(id) ? ["L", slotOf.get(id)] : ["E", capture(id)]);
    // `this` model: a non-arrow fn reads its receiver from the call frame (LOADTHIS),
    // falling back to its home this (env-captured instance, for ctor/accessor/super
    // paths that don't set a receiver). Arrows capture `this` lexically. `thisFwd` is
    // the id a child arrow uses to reference THIS function's `this`.
    const isArrow = node && ts.isArrowFunction(node);
    let _thisFwd = opts.thisId; const thisFwd = () => (_thisFwd != null ? _thisFwd : (_thisFwd = thisCounter--));
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
    // Resolve a TS type annotation to its runtime constructor (design:type / paramtypes),
    // the same lowering emitDecoratorMetadata does. Done syntactically: same-module class
    // references and the serializable builtins resolve; interfaces/unions/generics/cross-
    // module aliases fall back to Object (matching TS for non-class types). A full type
    // checker would be needed to follow imported type aliases.
    const TYPE_GLOBALS = new Set(["String", "Number", "Boolean", "Array", "Date"]);
    function emitTypeRef(typeNode) {
      if (!typeNode) { emit("GLOBAL", "Object"); return; }
      if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
        const tn = typeNode.typeName.text;
        if (topClassByName.has(tn)) { classObject(topClassByName.get(tn)); return; }                     // same-module class
        const imp = importResolve(typeNode.typeName); if (imp && imp.kind === "class") { emit("MAKECLOSURE", `%${imp.uname}`, []); emit("CALLV", 0); return; } // imported class (checker-resolved across modules)
        if (TYPE_GLOBALS.has(tn)) { emit("GLOBAL", tn); return; }      // String/Number/Boolean/Array/Date wrappers
        emit("GLOBAL", "Object"); return;                             // interface / alias / generic -> Object
      }
      switch (typeNode.kind) {
        case ts.SyntaxKind.StringKeyword: emit("GLOBAL", "String"); return;
        case ts.SyntaxKind.NumberKeyword: emit("GLOBAL", "Number"); return;
        case ts.SyntaxKind.BooleanKeyword: emit("GLOBAL", "Boolean"); return;
        case ts.SyntaxKind.ArrayType: case ts.SyntaxKind.TupleType: emit("GLOBAL", "Array"); return;
        case ts.SyntaxKind.VoidKeyword: case ts.SyntaxKind.UndefinedKeyword: case ts.SyntaxKind.NullKeyword: case ts.SyntaxKind.NeverKeyword: emit("PUSH", undefined); return;
        default: emit("GLOBAL", "Object"); return;
      }
    }
    const unresolvedId = (n) => bindingOf.get(n) == null && !topFns.has(n.text) && !topClassByName.has(n.text) && !importResolve(n) && !GLOBAL_OBJS.has(n.text) && !GLOBAL_CALLS.has(n.text) && !CTOR_GLOBALS.has(n.text) && !["undefined", "NaN", "Infinity"].includes(n.text);
    const emitImport = (ref) => { // reference another module's already-compiled export by namespaced global name
      if (ref.kind === "class") { emit("MAKECLOSURE", `%${ref.uname}`, []); emit("CALLV", 0); return; } // its class object
      if (ref.kind === "fn") { emit("MAKECLOSURE", ref.name, [], ref.gen); return; }
      emit("MGET", ref.name); // const/let/var binding (per-tier registry)
    };
    function readUse(idNode) {
      const cn = classNameOf(idNode); if (cn) { classObject(cn); return; }  // bare `ClassName` (top-level or local) -> the class object
      const id = bindingOf.get(idNode);
      if (id == null) {
        if (topFns.has(idNode.text)) { compileTop(idNode.text); emit("MAKECLOSURE", G(idNode.text), [], generatorFns.has(idNode.text)); return; }
        const imp = importResolve(idNode); if (imp) { emitImport(imp); return; } // imported value
        if (GLOBAL_OBJS.has(idNode.text)) { emit("GLOBAL", idNode.text); return; } // bare `Math`/`JSON`/... -> host global
        if (idNode.text === "undefined") { emit("PUSH", undefined); return; }
        if (idNode.text === "NaN") { emit("PUSH", NaN); return; }
        if (idNode.text === "Infinity") { emit("PUSH", Infinity); return; }
        fail(idNode, "unresolved identifier");
      }
      if (moduleBindings.has(id)) { emit("MGET", moduleBindings.get(id)); return; } // module-level binding (per-tier registry)
      if (slotOf.has(id)) { emit("LOAD", slotOf.get(id)); if (boxed.has(id)) emit("GETPROP", "v"); return; }
      emit("LOADENV", capture(id)); if (boxed.has(id)) emit("GETPROP", "v");
    }
    function writeUse(idNode, valThunk) {
      const id = bindingOf.get(idNode); if (id == null) fail(idNode, "assign to non-variable");
      if (moduleBindings.has(id)) { valThunk(); emit("MSET", moduleBindings.get(id)); return; } // module-level binding
      if (boxed.has(id)) { if (slotOf.has(id)) emit("LOAD", slotOf.get(id)); else emit("LOADENV", capture(id)); valThunk(); emit("SETPROP", "v"); emit("POP"); return; }
      valThunk(); emit("STORE", slotOf.get(id));
    }
    // A reference whose base/key are evaluated ONCE; {get, set} so assignment,
    // compound, ++/--, and logical-assignment all single-eval and can leave a value.
    function compileRef(target) {
      if (ts.isParenthesizedExpression(target)) return compileRef(target.expression);
      if (ts.isIdentifier(target)) return { get: () => readUse(target), set: (v) => writeUse(target, v) };
      if (ts.isPropertyAccessExpression(target)) { const o = tempSlot(); expr(target.expression); emit("STORE", o); const key = target.name.text; return { get: () => { emit("LOAD", o); emit(getOp(key), key); }, set: (v) => { emit("LOAD", o); v(); emit(setOp(key), key); emit("POP"); } }; }
      if (ts.isElementAccessExpression(target)) { const o = tempSlot(), kk = tempSlot(); expr(target.expression); emit("STORE", o); expr(target.argumentExpression); emit("STORE", kk); return { get: () => { emit("LOAD", o); emit("LOAD", kk); emit("INDEX"); }, set: (v) => { emit("LOAD", o); emit("LOAD", kk); v(); emit("SETINDEX"); } }; }
      return null; // destructuring patterns handled by the caller
    }
    function assignExpr(target, rhsThunk) {    // target = rhs, leaving the assigned value (assignment is an expression)
      if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) { const t = tempSlot(); rhsThunk(); emit("STORE", t); destructureAssign(target, t); emit("LOAD", t); return; } // value of a destructuring assignment is the RHS
      const r = compileRef(target); if (!r) fail(target, "unsupported assignment target");
      const t = tempSlot(); rhsThunk(); emit("STORE", t); r.set(() => emit("LOAD", t)); emit("LOAD", t);
    }
    function compoundExpr(target, op, rhs) {   // target op= rhs, leaving the new value
      const r = compileRef(target); if (!r) fail(target, "unsupported compound-assignment target");
      const t = tempSlot(); r.get(); expr(rhs); emit("BIN", op); emit("STORE", t); r.set(() => emit("LOAD", t)); emit("LOAD", t);
    }
    function logicalAssignExpr(target, kind, rhs) { // &&= / ||= / ??=  (short-circuit), leaving the resulting value
      const r = compileRef(target); if (!r) fail(target, "unsupported assignment target");
      const t = tempSlot(); r.get(); emit("STORE", t); emit("LOAD", t);
      if (kind === "&&") { /* assign when truthy */ } else if (kind === "||") emit("NOT"); else emit("ISNULLISH"); // assign when: truthy / falsy / nullish
      const skip = label("la"); emit("JMPF", skip); expr(rhs); emit("STORE", t); r.set(() => emit("LOAD", t)); mark(skip); emit("LOAD", t);
    }
    function assignTo(target, valThunk) {      // target = e (returns nothing; statement-shaped) — used for destructuring elements
      if (ts.isIdentifier(target)) { writeUse(target, valThunk); return; }
      if (ts.isPropertyAccessExpression(target)) { expr(target.expression); valThunk(); emit(setOp(target.name.text), target.name.text); emit("POP"); return; }
      if (ts.isElementAccessExpression(target)) { expr(target.expression); expr(target.argumentExpression); valThunk(); emit("SETINDEX"); return; }
      if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) { const t = tempSlot(); valThunk(); emit("STORE", t); destructureAssign(target, t); return; } // [a,b]=.. / ({x,y}=..)
      if (ts.isParenthesizedExpression(target)) { assignTo(target.expression, valThunk); return; }
      fail(target, "unsupported assignment target");
    }
    function destrElem(target, def, getVal) {  // assign getVal() (with default if === undefined) to a possibly-nested target
      const val = () => { getVal(); if (def) { emit("DUP"); emit("PUSH", undefined); emit("BIN", "==="); const skip = label("dd"); emit("JMPF", skip); emit("POP"); expr(def); mark(skip); } };
      if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) { const t = tempSlot(); val(); emit("STORE", t); destructureAssign(target, t); }
      else assignTo(target, val);
    }
    function destructureAssign(pat, srcSlot) {  // destructuring ASSIGNMENT into existing targets (vars/props)
      if (ts.isArrayLiteralExpression(pat)) {
        emit("LOAD", srcSlot); emit("TOARRAY"); emit("STORE", srcSlot); // iterator-protocol destructuring for non-array iterables
        pat.elements.forEach((el, i) => {
          if (ts.isOmittedExpression(el)) return;
          if (ts.isSpreadElement(el)) { assignTo(el.expression, () => { emit("LOAD", srcSlot); emit("PUSH", i); emit("CALLM", "slice", 1); }); return; }
          const def = ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken ? el.right : null;
          destrElem(def ? el.left : el, def, () => { emit("LOAD", srcSlot); emit("PUSH", i); emit("INDEX"); });
        });
        return;
      }
      for (const p of pat.properties) {
        if (ts.isShorthandPropertyAssignment(p)) { destrElem(p.name, p.objectAssignmentInitializer || null, () => { emit("LOAD", srcSlot); emit("GETPROP", p.name.text); }); }
        else if (ts.isPropertyAssignment(p)) { const def = ts.isBinaryExpression(p.initializer) && p.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken ? p.initializer.right : null; destrElem(def ? p.initializer.left : p.initializer, def, () => { emit("LOAD", srcSlot); emit("GETPROP", p.name.text); }); }
        else fail(p, "unsupported destructuring-assignment property");
      }
    }
    function incDec(target, op, post) {        // x++ / ++x — single-eval base; leaves old (postfix) or new (prefix). INC/DEC are type-aware (1 vs 1n)
      const step = op === "+" ? "INC" : "DEC"; const r = compileRef(target); if (!r) fail(target, "unsupported ++/-- target");
      const t = tempSlot(); r.get(); emit("STORE", t); r.set(() => { emit("LOAD", t); emit(step); });
      if (post) emit("LOAD", t); else { emit("LOAD", t); emit(step); }
      return true;
    }
    function bindStackTop(nameNode) { // a value is on the stack; store into the binding (decl/for-of/destructure)
      const id = bindingOf.get(nameNode), fresh = arguments[1]; // fresh: a NEW cell (loop/catch per-iteration capture) vs filling the pre-created one
      if (moduleBindings.has(id)) { emit("MSET", moduleBindings.get(id)); }
      else if (boxed.has(id)) { if (fresh) { const t = tempSlot(); emit("STORE", t); emit("NEWOBJ"); emit("LOAD", t); emit("SETPROP", "v"); emit("STORE", slotOf.get(id)); } else { const t = tempSlot(); emit("STORE", t); emit("LOAD", slotOf.get(id)); emit("LOAD", t); emit("SETPROP", "v"); emit("POP"); } }
      else emit("STORE", slotOf.get(id));
    }
    function bindOne(el, pushRaw) {              // raw value -> apply default (if value===undefined) -> bind name/pattern
      pushRaw();
      if (el.initializer) { emit("DUP"); emit("PUSH", undefined); emit("BIN", "==="); const skip = label("dflt"); emit("JMPF", skip); emit("POP"); expr(el.initializer); mark(skip); }
      if (ts.isIdentifier(el.name)) bindStackTop(el.name);
      else { const t = tempSlot(); emit("STORE", t); bindPattern(el.name, t); }
    }
    function bindPattern(pattern, srcSlot) {
      if (ts.isObjectBindingPattern(pattern)) {
        const bound = [];
        for (const el of pattern.elements) {
          if (el.dotDotDotToken) { const t = tempSlot(); emit("NEWOBJ"); emit("LOAD", srcSlot); emit("ASSIGNALL"); emit("STORE", t); for (const k of bound) if (k != null) { emit("LOAD", t); emit("DELPROP", k); emit("POP"); } emit("LOAD", t); bindStackTop(el.name); continue; } // {...rest}
          if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) { bound.push(null); bindOne(el, () => { emit("LOAD", srcSlot); expr(el.propertyName.expression); emit("INDEX"); }); continue; } // { [k]: v } / { [sym]: v }
          const key = (el.propertyName || el.name).text; bound.push(key);
          bindOne(el, () => { emit("LOAD", srcSlot); emit("GETPROP", key); });
        }
        return;
      }
      if (ts.isArrayBindingPattern(pattern)) {
        emit("LOAD", srcSlot); emit("TOARRAY"); emit("STORE", srcSlot); // array destructuring consumes the iterator protocol (Set/generator/custom iterable)
        pattern.elements.forEach((el, i) => {
          if (ts.isOmittedExpression(el)) return;
          if (el.dotDotDotToken) { emit("LOAD", srcSlot); emit("PUSH", i); emit("CALLM", "slice", 1); bindStackTop(el.name); return; } // [...rest]
          bindOne(el, () => { emit("LOAD", srcSlot); emit("PUSH", i); emit("INDEX"); });
        });
        return;
      }
      fail(pattern, "unsupported binding pattern");
    }
    function closureOf(fnNode) {
      const childName = `${name}$${gen++}`; const isA = ts.isArrowFunction(fnNode);
      const child = compileFn(fnNode, childName, isA ? { thisId: thisFwd(), superName: opts.superName } : {}); out[childName] = child; // arrows capture lexical this/super
      const fwd = _thisFwd; // the id arrows use for our `this`; a non-arrow owner snapshots its dynamic this as ["T"], an arrow owner forwards its (already-lexical) captured this
      emit("MAKECLOSURE", childName, child.freeIds.map((id) => (isA && !isArrow && id === fwd ? ["T", opts.thisId != null ? capture(opts.thisId) : -1] : provide(id))), !!fnNode.asteriskToken);
    }

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
      if (ts.isTaggedTemplateExpression(node)) {                  // tag`a${x}b` -> tag(strings, x) ; strings.raw set
        const tpl = node.template, rawOf = (n) => (n.rawText !== undefined ? n.rawText : n.text);
        let cooked, raws, exprs;
        if (ts.isNoSubstitutionTemplateLiteral(tpl)) { cooked = [tpl.text]; raws = [rawOf(tpl)]; exprs = []; }
        else { cooked = [tpl.head.text, ...tpl.templateSpans.map((s) => s.literal.text)]; raws = [rawOf(tpl.head), ...tpl.templateSpans.map((s) => rawOf(s.literal))]; exprs = tpl.templateSpans.map((s) => s.expression); }
        const strArr = cooked.slice(); strArr.raw = raws; const argc = 1 + exprs.length; // a constant array (template-string identity is cached, matching JS)
        if (ts.isPropertyAccessExpression(node.tag)) { expr(node.tag.expression); emit("PUSH", strArr); exprs.forEach((e) => expr(e)); emit("CALLMETHOD", node.tag.name.text, argc); } // e.g. String.raw`...`
        else { expr(node.tag); emit("PUSH", strArr); exprs.forEach((e) => expr(e)); emit("CALLV", argc); }
        return true;
      }
      if (node.kind === ts.SyntaxKind.TrueKeyword) { emit("PUSH", true); return true; }
      if (node.kind === ts.SyntaxKind.FalseKeyword) { emit("PUSH", false); return true; }
      if (node.kind === ts.SyntaxKind.NullKeyword) { emit("PUSH", null); return true; }
      if (node.kind === ts.SyntaxKind.ThisKeyword) { if (isArrow) { if (opts.thisId == null) { emit("PUSH", undefined); return true; } emit("LOADENV", capture(opts.thisId)); return true; } emit("LOADTHIS", opts.thisId != null ? capture(opts.thisId) : -1); return true; } // arrow: lexical; else dynamic receiver, home this as fallback
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.NewKeyword) { if (opts.ctorOf) classObject(opts.ctorOf); else emit("PUSH", undefined); return true; } // new.target: the class in a ctor, else undefined
      if (ts.isNewExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === "Proxy" && bindingOf.get(node.expression) == null) { const a = node.arguments || []; expr(a[0]); expr(a[1]); emit("NEWPROXY"); return true; } // new Proxy(target, handler)
        if (ts.isIdentifier(node.expression) && bindingOf.get(node.expression) == null && CTOR_GLOBALS.has(node.expression.text)) { const a = node.arguments || []; a.forEach((x) => expr(x)); emit("CTORG", node.expression.text, a.length); return true; } // new Map/Set/Date/...
        const cname = ts.isIdentifier(node.expression) ? classNameOf(node.expression) : null;
        if (!cname) { // dynamic `new C(...)` — C is a runtime class value (DI container resolving a constructor)
          expr(node.expression); emit("GETPROP", "__construct__");
          spreadArgs(node.arguments || []); emit("CALLV", 1); return true; // __construct__(argsArray) — the array is one argument; %new_ spreads it to the ctor
        }
        const ctx = { emit, expr, tempSlot, provide, classObject };
        const { rec, inst } = emitInstanceAssembly(cname, ctx);
        const args = node.arguments || []; // every class has a constructor now (explicit or synthesized)
        const info = rec.compiled.__ctor__; emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === rec.thisId ? ["L", inst] : provide(id)))); args.forEach((a) => expr(a)); emit("CALLV", args.length); emit("POP");
        emit("LOAD", inst); return true;
      }
      if (ts.isIdentifier(node)) { readUse(node); return true; }
      if (ts.isAwaitExpression(node)) { expr(node.expression); emit("AWAIT"); return true; }
      if (ts.isYieldExpression(node)) {
        if (node.asteriskToken) {                                 // yield* E: drive E's iterator, forwarding sent values; result = E's return value
          const it = tempSlot(), sent = tempSlot(); expr(node.expression); emit("ITER"); emit("STORE", it); emit("PUSH", undefined); emit("STORE", sent);
          const loop = label("ys"), body = label("ysb"), end = label("yse"); mark(loop);
          emit("LOAD", it); emit("LOAD", sent); emit("GENNEXT");                      // {value,done} = inner.next(sent)
          emit("DUP"); emit("GETPROP", "done"); emit("JMPF", body);
          emit("GETPROP", "value"); emit("JMP", end);                                 // done -> inner's return value
          mark(body); emit("GETPROP", "value"); emit("YIELD"); emit("STORE", sent); emit("JMP", loop); // yield value; capture sent for next round
          mark(end); return true;
        }
        node.expression ? expr(node.expression) : emit("PUSH", undefined); emit("YIELD"); return true; // YIELD leaves the sent value as the expr's value
      }
      if (ts.isTypeOfExpression(node)) { if (ts.isIdentifier(node.expression) && unresolvedId(node.expression)) { emit("PUSH", undefined); } else expr(node.expression); emit("TYPEOF"); return true; } // typeof undeclared -> "undefined"
      if (ts.isVoidExpression(node)) { expr(node.expression); emit("POP"); emit("PUSH", undefined); return true; }
      if (ts.isRegularExpressionLiteral(node)) { const m = node.text.match(/^\/(.*)\/([a-z]*)$/s); emit("PUSH", new RegExp(m[1], m[2])); return true; }
      if (ts.isDeleteExpression(node)) { const t = node.expression; if (ts.isPropertyAccessExpression(t)) { expr(t.expression); emit("DELPROP", t.name.text); } else if (ts.isElementAccessExpression(t)) { expr(t.expression); expr(t.argumentExpression); emit("DELINDEX"); } else fail(node, "unsupported delete"); return true; }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) { closureOf(node); return true; }
      if (ts.isConditionalExpression(node)) { expr(node.condition); const els = label("tern"), end = label("tend"); emit("JMPF", els); expr(node.whenTrue); emit("JMP", end); mark(els); expr(node.whenFalse); mark(end); return true; }
      if (ts.isPrefixUnaryExpression(node)) {
        if (node.operator === ts.SyntaxKind.ExclamationToken) { expr(node.operand); emit("NOT"); return true; }
        if (node.operator === ts.SyntaxKind.TildeToken) { expr(node.operand); emit("BITNOT"); return true; }
        if (node.operator === ts.SyntaxKind.MinusToken) { expr(node.operand); emit("NEG"); return true; } // -x (correct -0, BigInt)
        if (node.operator === ts.SyntaxKind.PlusToken) { expr(node.operand); emit("PUSH", 1); emit("BIN", "*"); return true; } // unary + (numeric coercion)
        if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) return incDec(node.operand, node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-", false); // ++x: new value
        fail(node, "unsupported unary");
      }
      if (ts.isPostfixUnaryExpression(node)) return incDec(node.operand, node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-", true); // x++: old value
      if (ts.isBinaryExpression(node)) {
        const k = node.operatorToken.kind;
        if (k === ts.SyntaxKind.EqualsToken) { assignExpr(node.left, () => expr(node.right)); return true; } // assignment is an expression (a = b = c works)
        if (COMPOUND.has(k)) { compoundExpr(node.left, COMPOUND.get(k), node.right); return true; }
        if (k === ts.SyntaxKind.AmpersandAmpersandToken) { expr(node.left); emit("DUP"); const end = label("and"); emit("JMPF", end); emit("POP"); expr(node.right); mark(end); return true; }
        if (k === ts.SyntaxKind.BarBarToken) { expr(node.left); emit("DUP"); const rhs = label("or"), end = label("oend"); emit("JMPF", rhs); emit("JMP", end); mark(rhs); emit("POP"); expr(node.right); mark(end); return true; }
        if (k === ts.SyntaxKind.QuestionQuestionToken) { expr(node.left); emit("DUP"); emit("ISNULLISH"); const end = label("nc"); emit("JMPF", end); emit("POP"); expr(node.right); mark(end); return true; }
        if (k === ts.SyntaxKind.CommaToken) { if (expr(node.left)) emit("POP"); return expr(node.right); }
        if (k === ts.SyntaxKind.AmpersandAmpersandEqualsToken) { logicalAssignExpr(node.left, "&&", node.right); return true; }
        if (k === ts.SyntaxKind.BarBarEqualsToken) { logicalAssignExpr(node.left, "||", node.right); return true; }
        if (k === ts.SyntaxKind.QuestionQuestionEqualsToken) { logicalAssignExpr(node.left, "??", node.right); return true; }
        if (k === ts.SyntaxKind.InstanceOfKeyword) {
          const cn = ts.isIdentifier(node.right) ? classNameOf(node.right) : null;
          if (cn) { expr(node.left); emit("ISA", cn); return true; } // user class (this module)
          const imp = ts.isIdentifier(node.right) ? importResolve(node.right) : null;
          if (imp && imp.kind === "class") { expr(node.left); emit("ISA", imp.uname); return true; } // imported class
          if (ts.isIdentifier(node.right) && bindingOf.get(node.right) == null && BUILTIN_CTORS.has(node.right.text)) { expr(node.left); emit("ISAB", node.right.text); return true; } // Error/TypeError/Array/Map/...
          fail(node, "instanceof needs a class or built-in constructor");
        }
        const op = BINOP[k]; if (!op) fail(node, "unsupported operator");
        if (op === "in") { expr(node.left); expr(node.right); emit("HASKEY"); return true; } // `k in o`, proxy-aware (has trap)
        expr(node.left); expr(node.right); emit("BIN", op); return true;
      }
      if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) { if (!opts.superName) fail(node, "super outside a derived class"); return superProp(node.name.text); } // super.x
      if (ts.isPropertyAccessExpression(node)) { expr(node.expression); emit(getOp(node.name.text), node.name.text); return true; }
      if (ts.isElementAccessExpression(node)) { expr(node.expression); expr(node.argumentExpression); emit("INDEX"); return true; }
      if (ts.isObjectLiteralExpression(node)) {
        const hasFn = node.properties.some((p) => ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p));
        if (!hasFn) {                                            // fast path: plain data object, chained on the stack
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
        // methods/getters/setters bind `this` = the literal -> build in a temp, give the literal a synthetic thisId
        const o = tempSlot(); emit("NEWOBJ"); emit("STORE", o);
        let tid = objLiteralThis.get(node); if (tid == null) { tid = thisCounter--; objLiteralThis.set(node, tid); }
        const mk = (fnNode) => { const prog = `obj$${gen++}`; const c = compileFn(fnNode, prog, { thisId: tid }); out[prog] = c; emit("MAKECLOSURE", prog, c.freeIds.map((id) => (id === tid ? ["L", o] : provide(id))), !!fnNode.asteriskToken); };
        const accs = new Map(); const caccs = []; // static (by name) and computed ({kind,keyExpr,node}) accessors
        for (const p of node.properties) {
          if (ts.isSpreadAssignment(p)) { emit("LOAD", o); expr(p.expression); emit("ASSIGNALL"); emit("POP"); }
          else if (ts.isMethodDeclaration(p) && ts.isComputedPropertyName(p.name)) { emit("LOAD", o); expr(p.name.expression); mk(p); emit("SETINDEX"); } // { [k](){} } / { [Symbol.iterator](){} }
          else if (ts.isMethodDeclaration(p) && !ts.isComputedPropertyName(p.name)) { emit("LOAD", o); mk(p); emit("SETPROP", p.name.text); emit("POP"); }
          else if (ts.isGetAccessorDeclaration(p) && ts.isComputedPropertyName(p.name)) { caccs.push({ kind: "get", keyExpr: p.name.expression, node: p }); } // { get [k](){} }
          else if (ts.isSetAccessorDeclaration(p) && ts.isComputedPropertyName(p.name)) { caccs.push({ kind: "set", keyExpr: p.name.expression, node: p }); }
          else if (ts.isGetAccessorDeclaration(p)) { const e = accs.get(p.name.text) || {}; e.get = p; accs.set(p.name.text, e); }
          else if (ts.isSetAccessorDeclaration(p)) { const e = accs.get(p.name.text) || {}; e.set = p; accs.set(p.name.text, e); }
          else if (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name)) { emit("LOAD", o); expr(p.name.expression); expr(p.initializer); emit("SETINDEX"); }
          else if (ts.isPropertyAssignment(p)) { emit("LOAD", o); expr(p.initializer); emit("SETPROP", p.name.text); emit("POP"); }
          else if (ts.isShorthandPropertyAssignment(p)) { emit("LOAD", o); readUse(p.name); emit("SETPROP", p.name.text); emit("POP"); }
          else fail(p, "unsupported property");
        }
        if (accs.size || caccs.length) {
          const tbl = tempSlot(); emit("NEWOBJ"); emit("STORE", tbl);
          for (const [aname, e] of accs) { const ent = tempSlot(); emit("NEWOBJ"); emit("STORE", ent); for (const kind of ["get", "set"]) { if (!e[kind]) continue; emit("LOAD", ent); mk(e[kind]); emit("SETPROP", kind); emit("POP"); } emit("LOAD", tbl); emit("LOAD", ent); emit("SETPROP", aname); emit("POP"); }
          for (const c of caccs) { // computed key: evaluate, merge into the table entry at runtime (so get+set on the same key coexist)
            const kt = tempSlot(); expr(c.keyExpr); emit("STORE", kt);
            const et = tempSlot(); emit("LOAD", tbl); emit("LOAD", kt); emit("INDEX"); emit("STORE", et);
            const skip = label("cacc"); emit("LOAD", et); emit("ISNULLISH"); emit("JMPF", skip); emit("NEWOBJ"); emit("STORE", et); mark(skip);
            emit("LOAD", et); mk(c.node); emit("SETPROP", c.kind); emit("POP");
            emit("LOAD", tbl); emit("LOAD", kt); emit("LOAD", et); emit("SETINDEX");
          }
          emit("LOAD", o); emit("LOAD", tbl); emit("SETHIDDEN", "__accessors__"); emit("POP");
        }
        emit("LOAD", o); return true;
      }
      if (ts.isArrayLiteralExpression(node)) { emit("NEWARR"); for (const el of node.elements) { if (ts.isSpreadElement(el)) { expr(el.expression); emit("APPENDALL"); } else { emit("DUP"); expr(el); emit("ARRPUSH"); } } return true; }
      if (ts.isCallExpression(node)) return call(node);
      fail(node, "unsupported expression");
    }

    function hof(objNode, kind, args) {                         // inline-compile map/filter/forEach/reduce/find/findIndex/some/every (array receiver)
      if (!args.length) { expr(objNode); emit("CALLMETHOD", kind, 0); return true; } // no callback -> never the array HOF; a real method (e.g. a repository's .find())
      const src = tempSlot();
      expr(objNode); emit("STORE", src);
      const valueProducing = kind !== "forEach";
      // The HOF names collide with user/host method names (a repository's .find(),
      // Map/Set .forEach, ...). Inline only when the receiver is actually an array;
      // otherwise dispatch the real method. (Inlining is what lets a callback await/
      // migrate, so it's worth keeping for the common array case.)
      const hostL = label("hofhost"), doneL = label("hofdone");
      emit("LOAD", src); emit("ISARRAY"); emit("JMPF", hostL);
      const fn = tempSlot(), i = tempSlot();
      expr(args[0]); emit("STORE", fn);
      let acc = null, outv = null, res = null;
      if (kind === "reduce") { if (args.length < 2) fail(objNode, "reduce needs an initial value"); acc = tempSlot(); expr(args[1]); emit("STORE", acc); }
      else if (kind === "map" || kind === "filter") { outv = tempSlot(); emit("NEWARR"); emit("STORE", outv); }
      else if (kind === "find") { res = tempSlot(); emit("PUSH", undefined); emit("STORE", res); }
      else if (kind === "findIndex") { res = tempSlot(); emit("PUSH", -1); emit("STORE", res); }
      else if (kind === "some" || kind === "every") { res = tempSlot(); emit("PUSH", kind === "every"); emit("STORE", res); }
      emit("PUSH", 0); emit("STORE", i);
      const loop = label("hof"), end = label("hofend"); mark(loop);
      emit("LOAD", i); emit("LOAD", src); emit("GETPROP", "length"); emit("BIN", "<"); emit("JMPF", end);
      const elemThenIndex = () => { emit("LOAD", src); emit("LOAD", i); emit("INDEX"); emit("LOAD", i); };
      const callCb = () => { emit("LOAD", fn); elemThenIndex(); emit("CALLV", 2); };
      const elem = () => { emit("LOAD", src); emit("LOAD", i); emit("INDEX"); };
      if (kind === "map") { emit("LOAD", outv); callCb(); emit("ARRPUSH"); }
      else if (kind === "filter") { const skip = label("flt"); callCb(); emit("JMPF", skip); emit("LOAD", outv); elem(); emit("ARRPUSH"); mark(skip); }
      else if (kind === "forEach") { callCb(); emit("POP"); }
      else if (kind === "reduce") { emit("LOAD", fn); emit("LOAD", acc); elemThenIndex(); emit("CALLV", 3); emit("STORE", acc); }
      else if (kind === "find") { const skip = label("fnd"); callCb(); emit("JMPF", skip); elem(); emit("STORE", res); emit("JMP", end); mark(skip); }
      else if (kind === "findIndex") { const skip = label("fni"); callCb(); emit("JMPF", skip); emit("LOAD", i); emit("STORE", res); emit("JMP", end); mark(skip); }
      else if (kind === "some") { const skip = label("sm"); callCb(); emit("JMPF", skip); emit("PUSH", true); emit("STORE", res); emit("JMP", end); mark(skip); }
      else if (kind === "every") { const skip = label("ev"); callCb(); emit("NOT"); emit("JMPF", skip); emit("PUSH", false); emit("STORE", res); emit("JMP", end); mark(skip); }
      emit("LOAD", i); emit("PUSH", 1); emit("BIN", "+"); emit("STORE", i); emit("JMP", loop); mark(end);
      if (valueProducing) emit("LOAD", kind === "reduce" ? acc : outv != null ? outv : res);
      emit("JMP", doneL);
      mark(hostL); emit("LOAD", src); args.forEach((a) => expr(a)); emit("CALLMETHOD", kind, args.length); if (!valueProducing) emit("POP"); // real method dispatch (user .find()/.map(), Map/Set.forEach, ...)
      mark(doneL);
      return valueProducing;
    }

    function superHostCall(args) {                 // super(msg) when extending a host Error: set message (+ default name), like Error.call(this, msg)
      const t = capture(opts.thisId);
      emit("LOADENV", t); emit("PUSH", opts.hostSuper); emit("SETHIDDEN", "name"); emit("POP"); // non-enum default (overridable via this.name=)
      if (args.length) { emit("LOADENV", t); expr(args[0]); emit("SETHIDDEN", "message"); emit("POP"); } // Error message: own, non-enumerable (invisible to JSON/keys)
      emit("PUSH", undefined); return true;
    }
    function superCall(supProg, supThisId, args) {
      const sup = classes.get(opts.superName); compileClass(opts.superName);
      const info = supProg === "__ctor__" ? sup.compiled.__ctor__ : sup.compiled[supProg];
      if (!info) fail(args.node || node, "super target not found: " + supProg);
      emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === sup.thisId ? ["E", capture(opts.thisId)] : provide(id))));
      args.forEach((a) => expr(a)); emit("CALLV", args.length); return true;
    }
    function superProp(name) {                 // super.x — getter call / bound method / inherited data, walking the super chain
      for (let c = classes.get(opts.superName); c; c = c.superName ? classes.get(c.superName) : null) {
        compileClass(c.name);
        if (c.accessors.find((a) => a.name === name && a.kind === "get")) { const info = c.compiled[`get ${name}`]; emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === c.thisId ? ["E", capture(opts.thisId)] : provide(id)))); emit("CALLV", 0); return true; }
        if (c.methods.find((m) => m.name === name)) { const info = c.compiled[name]; emit("MAKECLOSURE", info.prog, info.freeIds.map((id) => (id === c.thisId ? ["E", capture(opts.thisId)] : provide(id))), !!c.methods.find((m) => m.name === name).node.asteriskToken); return true; }
      }
      emit("LOADENV", capture(opts.thisId)); emit("GETPROP", name); return true; // inherited data property
    }
    function promiseAll(arrNode) { expr(arrNode); emit("AWAITALL"); return true; } // resolve all elements CONCURRENTLY (one suspension) -> array
    const spreadArgs = (args) => { emit("NEWARR"); for (const a of args) { if (ts.isSpreadElement(a)) { expr(a.expression); emit("APPENDALL"); } else { emit("DUP"); expr(a); emit("ARRPUSH"); } } }; // build an args array on the stack
    const hostMethod = (m, args) => { if (args.some((a) => ts.isSpreadElement(a))) { spreadArgs(args); emit("CALLMS", m); } else { args.forEach((a) => expr(a)); emit("CALLM", m, args.length); } }; // object already on stack
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
      if (callee.kind === ts.SyntaxKind.SuperKeyword) { if (opts.hostSuper) return superHostCall(node.arguments); if (!opts.superName) fail(node, "super outside a derived class"); return superCall("__ctor__", null, node.arguments); }
      if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.SuperKeyword) { if (!opts.superName) fail(node, "super outside a derived class"); return superCall(callee.name.text, null, node.arguments); }
      if (ts.isPropertyAccessExpression(callee)) {
        const resName = `${callee.expression.getText(sf)}.${callee.name.text}`;
        if (resourceSet.has(resName)) { node.arguments.forEach((a) => expr(a)); emit("RES", resName, node.arguments.length); return true; }
        const m = callee.name.text;
        if (ts.isIdentifier(callee.expression) && callee.expression.text === "JSON" && m === "stringify" && bindingOf.get(callee.expression) == null) { const a = node.arguments; a[0] ? expr(a[0]) : emit("PUSH", undefined); a[1] ? expr(a[1]) : emit("PUSH", undefined); a[2] ? expr(a[2]) : emit("PUSH", undefined); emit("JSONSTR"); return true; } // skip Waso closures (functions) like JS does
        if (ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && m === "keys" && node.arguments.length === 1 && bindingOf.get(callee.expression) == null) { expr(node.arguments[0]); emit("KEYS"); return true; } // proxy-aware (ownKeys trap)
        if (ts.isIdentifier(callee.expression) && callee.expression.text === "Reflect" && bindingOf.get(callee.expression) == null) { const a = node.arguments; // proxy-aware reflection (handlers delegate to these)
          if (m === "get") { expr(a[0]); expr(a[1]); emit("INDEX"); return true; }
          if (m === "set") { expr(a[0]); expr(a[1]); expr(a[2]); emit("SETINDEX"); emit("PUSH", true); return true; }
          if (m === "has") { expr(a[1]); expr(a[0]); emit("HASKEY"); return true; }
          if (m === "deleteProperty") { expr(a[0]); expr(a[1]); emit("DELINDEX"); return true; }
          if (m === "ownKeys") { expr(a[0]); emit("KEYS"); return true; }
          if (m === "apply") { expr(a[0]); expr(a[1]); expr(a[2]); emit("REFAPPLY"); return true; }
          if (m === "construct") { expr(a[0]); emit("GETPROP", "__construct__"); a[1] ? expr(a[1]) : emit("NEWARR"); emit("CALLV", 1); return true; } // Reflect.construct(C, argsArray)
          // Reflect-metadata (runtime store; no design:type auto-emit — that needs the type checker)
          if (m === "defineMetadata") { expr(a[0]); expr(a[1]); expr(a[2]); a[3] ? expr(a[3]) : emit("PUSH", undefined); emit("DEFMETA"); return true; } // (mk, mv, target, pk?)
          if (m === "getMetadata" || m === "getOwnMetadata") { expr(a[0]); expr(a[1]); a[2] ? expr(a[2]) : emit("PUSH", undefined); emit("GETMETA"); return true; } // (mk, target, pk?)
          if (m === "hasMetadata" || m === "hasOwnMetadata") { expr(a[0]); expr(a[1]); a[2] ? expr(a[2]) : emit("PUSH", undefined); emit("HASMETA"); return true; }
          if (m === "getMetadataKeys" || m === "getOwnMetadataKeys") { expr(a[0]); a[1] ? expr(a[1]) : emit("PUSH", undefined); emit("METAKEYS"); return true; } // (target, pk?)
          if (m === "deleteMetadata") { expr(a[0]); expr(a[1]); a[2] ? expr(a[2]) : emit("PUSH", undefined); emit("DELMETA"); return true; }
          fail(node, "unsupported Reflect." + m);
        }
        if (ts.isIdentifier(callee.expression) && bindingOf.get(callee.expression) == null && GLOBAL_OBJS.has(callee.expression.text)) { emit("GLOBAL", callee.expression.text); hostMethod(m, node.arguments); return true; } // Math.max / Object.keys / JSON.stringify / Array.isArray ...
        if ((m === "next" || m === "return" || m === "throw") && node.arguments.length <= 1) { expr(callee.expression); node.arguments[0] ? expr(node.arguments[0]) : emit("PUSH", undefined); emit(m === "next" ? "GENNEXT" : m === "return" ? "GENRET" : "GENTHROW"); return true; } // it.next/return/throw(v)
        if (m === "push") { expr(callee.expression); expr(node.arguments[0]); emit("ARRPUSH"); return false; }
        if (HOF.has(m)) return hof(callee.expression, m, node.arguments);
        if (PLAIN_METHODS.has(m)) { expr(callee.expression); hostMethod(m, node.arguments); return true; }
        expr(callee.expression); // obj.m(...): CALLMETHOD dispatches user-closure method vs host method (Map/Set/...) at runtime
        if (node.arguments.some((a) => ts.isSpreadElement(a))) { spreadArgs(node.arguments); emit("CALLMETHODS", m); } else { node.arguments.forEach((a) => expr(a)); emit("CALLMETHOD", m, node.arguments.length); }
        return true;
      }
      if (ts.isIdentifier(callee) && bindingOf.get(callee) == null && !topFns.has(callee.text) && resourceSet.has(callee.text)) { node.arguments.forEach((a) => expr(a)); emit("RES", callee.text, node.arguments.length); return true; }
      if (ts.isIdentifier(callee) && callee.text === "BigInt" && bindingOf.get(callee) == null && !topFns.has(callee.text)) { expr(node.arguments[0]); emit("TOBIG"); return true; } // BigInt(x) conversion
      if (ts.isIdentifier(callee) && bindingOf.get(callee) == null && !topFns.has(callee.text) && GLOBAL_CALLS.has(callee.text)) { node.arguments.forEach((a) => expr(a)); emit("CALLG", callee.text, node.arguments.length); return true; } // parseInt/Number/String/... bare call
      if (ts.isElementAccessExpression(callee)) { expr(callee.expression); expr(callee.argumentExpression); if (node.arguments.some((a) => ts.isSpreadElement(a))) { spreadArgs(node.arguments); emit("CALLDYNS"); } else { node.arguments.forEach((a) => expr(a)); emit("CALLDYN", node.arguments.length); } return true; } // obj[k](...): dynamic dispatch (this = obj)
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
      if (ts.isIdentifier(d.name)) { const id = bindingOf.get(d.name); if (moduleBindings.has(id)) { init(); emit("MSET", moduleBindings.get(id)); } else if (boxed.has(id)) { emit("LOAD", slotOf.get(id)); init(); emit("SETPROP", "v"); emit("POP"); } else { init(); emit("STORE", slotOf.get(id)); } return; } // fill the pre-created cell
      if (!d.initializer) fail(d, "destructuring needs an initializer");
      const t = tempSlot(); expr(d.initializer); emit("STORE", t); bindPattern(d.name, t); // destructuring (module-level pattern targets resolve via writeUse->MSET)
    }

    function stmt(node) { const save = here; here = node; try { stmtInner(node); } finally { here = save; } }
    function stmtInner(node) {
      if (ts.isBlock(node)) return node.statements.forEach(stmt);
      if (ts.isClassDeclaration(node)) return; // local class decl: collected up-front, built lazily on first `new`/reference
      if (ts.isFunctionDeclaration(node)) return; // nested fn decls are HOISTED: created+filled in the prologue (callable before their textual position)
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
          if (cc.variableDeclaration && ts.isIdentifier(cc.variableDeclaration.name)) bindStackTop(cc.variableDeclaration.name, true);
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
        if (!node.expression) { unwind(-1); emit("PUSH", undefined); emit("RET"); return; } // `return;` -> undefined
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
        let perIter = []; // boxed let/const loop vars -> a fresh cell each iteration (closures capture per-iteration values); NOT var (one shared binding)
        if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
          const lexical = !!(node.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
          for (const d of node.initializer.declarations) declOne(d);
          if (lexical) for (const d of node.initializer.declarations) if (ts.isIdentifier(d.name)) { const id = bindingOf.get(d.name); if (boxed.has(id)) perIter.push(slotOf.get(id)); }
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
        emit("LOAD", iter); emit("LOAD", idx); emit("INDEX"); bindStackTop(decl.name, true);
        cf.push({ loop: true, brk: end, cont: step, name: lbl }); stmt(node.statement); cf.pop();
        mark(step); emit("LOAD", idx); emit("PUSH", 1); emit("BIN", "+"); emit("STORE", idx); emit("JMP", loop); mark(end); return;
      }
      if (ts.isForOfStatement(node)) {                            // full iterator protocol: arrays / generators / Map/Set/string / user [Symbol.iterator]
        const lbl = takeLabel(); const iter = tempSlot();
        expr(node.expression); emit("ITER"); emit("STORE", iter);
        const loop = label("loop"), body = label("body"), step = label("step"), end = label("end"); mark(loop);
        emit("LOAD", iter); emit("PUSH", undefined); emit("GENNEXT"); // -> { value, done }
        emit("DUP"); emit("GETPROP", "done"); emit("JMPF", body); emit("POP"); emit("JMP", end); // done -> drop result, exit
        mark(body); emit("GETPROP", "value");                     // stack: [value]
        if (node.awaitModifier) emit("AWAIT");                    // `for await`: await each value (identity for a plain value)
        const decl = node.initializer.declarations[0];
        if (ts.isIdentifier(decl.name)) bindStackTop(decl.name, true); else { const t = tempSlot(); emit("STORE", t); bindPattern(decl.name, t); }
        cf.push({ loop: true, brk: end, cont: step, name: lbl }); stmt(node.statement); cf.pop();
        mark(step); emit("JMP", loop); mark(end); return;
      }
      if (ts.isBreakStatement(node)) { const i = node.label ? targetForLabel(node.label.text, "break") : targetFor("break"); if (i < 0) fail(node, "break has no target"); unwind(i); emit("JMP", cf[i].brk); return; }
      if (ts.isContinueStatement(node)) { const i = node.label ? targetForLabel(node.label.text, "continue") : targetFor("continue"); if (i < 0) fail(node, "continue has no target"); unwind(i); emit("JMP", cf[i].cont); return; }
      fail(node, "unsupported statement");
    }

    if (opts.emitBody) { opts.emitBody({ emit, expr, stmt, tempSlot, label, mark, provide, capture, classObject, emitTypeRef }); const { code, pos } = assemble(); return { nlocals: topSlot, code, pos, freeIds: envIds }; } // synthetic class-object builder / module-init

    // --- prologue: rest param, default params, box captured params, fields, hoist nested fn decls
    let argsTemp = null; if (usesArguments.has(node)) { argsTemp = tempSlot(); emit("ARGUMENTS"); emit("STORE", argsTemp); } // snapshot passed args FIRST (before pre-create/defaults mutate locals); installed below
    for (const p of node.parameters) if (p.dotDotDotToken && ts.isIdentifier(p.name)) emit("GATHERREST", slotOf.get(bindingOf.get(p.name)));
    for (const p of node.parameters) if (p.initializer && ts.isIdentifier(p.name)) { const s = slotOf.get(bindingOf.get(p.name)); const skip = label("dflt"); emit("LOAD", s); emit("PUSH", undefined); emit("BIN", "==="); emit("JMPF", skip); expr(p.initializer); emit("STORE", s); mark(skip); }
    const paramIds = new Set(); for (const p of node.parameters) if (ts.isIdentifier(p.name)) paramIds.add(bindingOf.get(p.name));
    for (const p of node.parameters) if (ts.isIdentifier(p.name) && boxed.has(bindingOf.get(p.name))) { const s = slotOf.get(bindingOf.get(p.name)); emit("NEWOBJ"); emit("LOAD", s); emit("SETPROP", "v"); emit("STORE", s); }
    // Pre-create empty cells for every boxed function-scoped local (not params) so a
    // hoisted function / forward reference captures the SAME cell the later declaration fills.
    for (const id of ids) if (boxed.has(id) && slotOf.has(id) && !paramIds.has(id)) { emit("NEWOBJ"); emit("STORE", slotOf.get(id)); }
    if (argsTemp != null) { const aid = usesArguments.get(node), s = slotOf.get(aid); if (boxed.has(aid)) { emit("LOAD", s); emit("LOAD", argsTemp); emit("SETPROP", "v"); emit("POP"); } else { emit("LOAD", argsTemp); emit("STORE", s); } } // install `arguments` (into its cell if boxed)
    node.parameters.forEach((p, i) => { if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) { if (p.initializer) { const skip = label("pd"); emit("LOAD", i); emit("PUSH", undefined); emit("BIN", "==="); emit("JMPF", skip); expr(p.initializer); emit("STORE", i); mark(skip); } bindPattern(p.name, i); } }); // destructuring params: raw arg at slot i (= position)
    if (opts.fieldInits) for (const f of opts.fieldInits) { emit("LOADENV", capture(opts.thisId)); expr(f.init); emit("SETPROP", f.name); emit("POP"); } // class field initializers, with `this` bound
    // Nested function declarations are HOISTED: cells pre-created above; fill the closures now (callable before their textual position; mutual recursion via shared cells).
    const findFnDecls = (n, acc) => { if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return; if (ts.isFunctionDeclaration(n) && n !== node) { acc.push(n); return; } ts.forEachChild(n, (c) => findFnDecls(c, acc)); };
    const fnDecls = []; if (node.body) ts.forEachChild(node.body, (c) => findFnDecls(c, fnDecls));
    for (const fd of fnDecls) { const childName = `${name}$${gen++}`; const child = compileFn(fd, childName); out[childName] = child; emit("LOAD", slotOf.get(bindingOf.get(fd.name))); emit("MAKECLOSURE", childName, child.freeIds.map(provide), !!fd.asteriskToken); emit("SETPROP", "v"); emit("POP"); }

    if (node.body && ts.isBlock(node.body)) node.body.statements.forEach(stmt);
    else { expr(node.body); emit("RET"); }
    const last = asm[asm.length - 1];
    if (!(Array.isArray(last) && last[0] === "RET")) { emit("PUSH", undefined); emit("RET"); } // fall off the end -> undefined
    const { code, pos } = assemble();
    return { nlocals: topSlot, code, pos, freeIds: envIds };
  }

  if (entry) compileTop(entry);
  // Eagerly compile this module's exports (functions + classes) so other modules can
  // reference them by namespaced global name without re-entering this module's context.
  for (const s of sf.statements) {
    if (!(s.modifiers || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(s) && s.name) compileTop(s.name.text);
    else if (ts.isClassDeclaration(s) && s.name && topClassByName.has(s.name.text)) { const u = topClassByName.get(s.name.text); compileClass(u); neededBuilders.add(u); } // generate the class-object + __construct__ builders so importers can reference them
  }
  // Module-init: run the top-level statements (var decls -> MSET, side-effecting
  // expressions) once per tier, before anything else. Function/class declarations
  // and TS-only nodes are NOT executed here (handled separately).
  const initStmts = sf.statements.filter((s) => ts.isVariableStatement(s) || ts.isExpressionStatement(s) || ts.isIfStatement(s) || ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isWhileStatement(s) || ts.isDoStatement(s) || ts.isSwitchStatement(s) || ts.isTryStatement(s) || ts.isBlock(s) || ts.isThrowStatement(s));
  const decoratedClasses = [...classes.values()].filter((r) => r.topLevel && ((r.decorators && r.decorators.length) || r.hasMemberDec)); // class + member decorators run at module load (eager class-object build)
  // Apply class decorators bottom-up: `C = d0(d1(...(C)))`; a non-null return rebinds
  // the cached class object (registration decorators return nothing — the common case).
  const emitDecorate = ({ emit, expr, tempSlot, label, mark, classObject }) => {
    for (const rec of decoratedClasses) {
      classObject(rec.name); const co = tempSlot(); emit("STORE", co); // build the class object eagerly
      for (let i = rec.decorators.length - 1; i >= 0; i--) { // source order is top-to-bottom; apply innermost (last) first
        expr(rec.decorators[i]); emit("LOAD", co); emit("CALLV", 1);
        const keep = label("deco"); emit("DUP"); emit("ISNULLISH"); emit("JMPF", keep); emit("POP"); emit("LOAD", co); mark(keep); emit("STORE", co); // co = result ?? co
      }
      emit("LOAD", co); emit("CLSPUT", rec.name); emit("POP"); // rebind so later `ClassName` references see the decorated class
    }
  };
  const hasInit = initStmts.length || decoratedClasses.length;
  if (hasInit) { const stub = { parameters: [] }; bindingsByFn.set(stub, bindingsByFn.get(null) || []); out[initName] = compileFn(stub, initName, { emitBody: (ctx) => { for (const s of initStmts) ctx.stmt(s); emitDecorate(ctx); ctx.emit("PUSH", undefined); ctx.emit("RET"); } }); }
  // Generate class-object builders now that every class is fully compiled (so
  // static-method freeIds are known). Fixpoint: a field init may reference more classes.
  const builtBuilders = new Set();
  const argStub = () => { const s = { parameters: [{}] }; bindingsByFn.set(s, [Symbol("args")]); return s; }; // reserves local slot 0 for the args array
  while ([...neededBuilders].some((c) => !builtBuilders.has(c))) {
    for (const cname of [...neededBuilders]) {
      if (builtBuilders.has(cname)) continue; builtBuilders.add(cname);
      out[`%${cname}`] = compileFn({ parameters: [] }, `%${cname}`, { emitBody: (ctx) => buildClassObjectBody(cname, ctx) });
      if (classes.get(cname).topLevel) out[`%new_${cname}`] = compileFn(argStub(), `%new_${cname}`, { emitBody: (ctx) => buildConstructBody(cname, ctx) }); // dynamic `new C(...)` / Reflect.construct (top-level classes capture nothing from outer scopes)
    }
  }
  return { initName: hasInit ? initName : null };
}

const fragOf = (out) => { const frag = {}; for (const [k, v] of Object.entries(out)) frag[k] = { nlocals: v.nlocals, code: v.code, pos: v.pos }; return frag; };

export function compileModule(source, { resources = [], entry = "main", file = "/app.ts" } = {}) {
  const program = makeProgram(new Map([[file, source]]));
  const out = {};
  compileInto(program.getSourceFile(file), program.getTypeChecker(), { resources, entry, prefix: "", out, initName: "%moduleinit" });
  return fragOf(out); // single module: core auto-runs "%moduleinit"
}

export function loadModule(PROGRAM, source, opts) { const frag = compileModule(source, opts); for (const [k, v] of Object.entries(frag)) PROGRAM[k] = v; return frag; }

// Multi-module: compile an import graph into one PROGRAM. `files` is Map<path, source>;
// the entry module keeps prefix "" (so its entry fn name is stable), every other module
// is namespaced m{i}$. Imports resolve through the type checker to the exporting module's
// namespaced global; module inits run in dependency order from a master "%moduleinit".
export function compileProgram(files, { entry = "main", entryFile, resources = [] } = {}) {
  const program = makeProgram(files);
  const checker = program.getTypeChecker();
  const paths = [...files.keys()];
  const ef = entryFile || paths[0];
  const depsOf = (p) => { const out = []; for (const s of program.getSourceFile(p).statements) { if (!ts.isImportDeclaration(s) && !ts.isExportDeclaration(s)) continue; const spec = s.moduleSpecifier; if (!spec) continue; const sym = checker.getSymbolAtLocation(spec); const d = sym && sym.declarations && sym.declarations[0]; const f = d && d.getSourceFile && d.getSourceFile().fileName; if (f && paths.includes(f)) out.push(f); } return out; };
  const order = [], seen = new Set(); const visit = (p, stack) => { if (seen.has(p) || stack.has(p)) return; stack.add(p); for (const d of depsOf(p)) visit(d, stack); stack.delete(p); seen.add(p); order.push(p); }; // deps before dependents
  for (const p of paths) visit(p, new Set());
  const prefixOf = new Map(); let mi = 0;
  for (const p of order) prefixOf.set(p, p === ef ? "" : `m${++mi}$`);
  // Map every exported top-level declaration node -> its namespaced runtime reference.
  const declRef = new Map();
  for (const p of order) { const pre = prefixOf.get(p); for (const s of program.getSourceFile(p).statements) {
    if (!(s.modifiers || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(s) && s.name) declRef.set(s, { kind: "fn", name: pre + s.name.text, gen: !!s.asteriskToken });
    else if (ts.isClassDeclaration(s) && s.name) declRef.set(s, { kind: "class", uname: pre + s.name.text });
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) declRef.set(d, { kind: "binding", name: pre + d.name.text });
  } }
  const importResolve = (idNode) => { let sym = checker.getSymbolAtLocation(idNode); if (!sym) return null; if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym); const decl = (sym.declarations || []).find((d) => declRef.has(d)); return decl ? declRef.get(decl) : null; };
  const out = {}; const inits = []; const sharedClasses = new Map(); // shared so cross-module inheritance resolves
  for (const p of order) { const isEntry = p === ef; const r = compileInto(program.getSourceFile(p), checker, { resources: isEntry ? resources : [], entry: isEntry ? entry : null, prefix: prefixOf.get(p), out, importResolve, sharedClasses, initName: `%init$${prefixOf.get(p)}` }); if (r.initName) inits.push(r.initName); }
  if (inits.length) { const code = []; for (const n of inits) code.push(["MAKECLOSURE", n, []], ["CALLV", 0], ["POP"]); code.push(["PUSH", undefined], ["RET"]); out["%moduleinit"] = { nlocals: 0, code, pos: code.map(() => null) }; } // master init: run each module's init in dependency order
  return fragOf(out);
}

export function loadProgram(PROGRAM, files, opts) { const frag = compileProgram(files, opts); for (const [k, v] of Object.entries(frag)) PROGRAM[k] = v; return frag; }

export function describeContinuation(PROGRAM, frames) {
  return frames.map((f, i) => { const at = Math.max(0, f.ip - 1); const loc = PROGRAM[f.fn] && PROGRAM[f.fn].pos ? PROGRAM[f.fn].pos[at] : null; return { depth: frames.length - 1 - i, fn: f.fn, loc }; });
}
