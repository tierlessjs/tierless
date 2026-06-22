// Waso — reference TypeScript frontend (design principle #1: "author writes
// ordinary TypeScript"). Lowers a small but real subset of TS to the Waso asm
// array that waso-wasm-core's assembler turns into bytecode. The IR is the true
// interface; this is just the reference lowering, using the TypeScript compiler
// API to parse (we parse the AST; we don't typecheck).
//
// Supported subset (enough to write the demo as real TS):
//   function NAME(p): number { ... }      params -> locals 0..k-1
//   const/let x = expr                    -> next local slot
//   for (let i = 0; i < e; i++) { ... }   C-style loop
//   if (cond) { ... }                     (no else needed here)
//   return expr
//   exprs: number literals, identifiers, (), x[i], x.length, [] (empty),
//          + - * < <= > >=, assignment, i++,
//          db.query(), DOM.renderList(x), arr.push(v)
//   resource calls (db.query / DOM.renderList) -> RES; everything else is local.

import ts from "typescript";
import { RESOURCES } from "./waso-wasm-core.mjs";

const BINOP = {
  [ts.SyntaxKind.LessThanToken]: "LT",
  [ts.SyntaxKind.GreaterThanEqualsToken]: "GE",
  [ts.SyntaxKind.PlusToken]: "ADD",
  // (>, <=, -, * are easy to add the same way when a program needs them)
};

export function compile(source, entryName = "render") {
  const sf = ts.createSourceFile("app.ts", source, ts.ScriptTarget.ES2020, true);
  const fn = sf.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name && s.name.text === entryName
  );
  if (!fn) throw new Error(`no function ${entryName} found`);

  const out = [];
  const locals = new Map();          // name -> slot
  const local = (name) => {
    if (!locals.has(name)) locals.set(name, locals.size);
    return locals.get(name);
  };
  fn.parameters.forEach((p) => local(p.name.text)); // params first: slots 0..k-1

  let labelN = 0;
  const label = (s) => `${s}${labelN++}`;
  const emit = (...ins) => out.push(ins);
  const mark = (l) => out.push(l);
  const fail = (node, msg) => { throw new Error(`waso-compile: ${msg}: \`${node.getText(sf)}\``); };

  // Compile an expression; returns true if it leaves exactly one value on the
  // operand stack (false for statement-shaped exprs like `arr.push(v)`/`i++`).
  function expr(node) {
    if (ts.isParenthesizedExpression(node)) return expr(node.expression);

    if (ts.isNumericLiteral(node)) { emit("PUSH", Number(node.text)); return true; }

    if (ts.isIdentifier(node)) {
      if (!locals.has(node.text)) fail(node, `unknown identifier`);
      emit("LOAD", local(node.text)); return true;
    }

    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (node.operator !== ts.SyntaxKind.PlusPlusToken) fail(node, "only ++ supported");
      const name = node.operand.text;                 // i++  ==>  i = i + 1
      emit("LOAD", local(name)); emit("PUSH", 1); emit("ADD"); emit("STORE", local(name));
      return false;
    }

    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) { // assignment
        if (!ts.isIdentifier(node.left)) fail(node, "can only assign to a variable");
        if (!expr(node.right)) fail(node, "rhs has no value");
        emit("STORE", local(node.left.text));
        return false;
      }
      const op = BINOP[node.operatorToken.kind];
      if (!op) fail(node, "unsupported operator");
      if (!expr(node.left)) fail(node.left, "no value");
      if (!expr(node.right)) fail(node.right, "no value");
      emit(op);
      return true;
    }

    if (ts.isArrayLiteralExpression(node)) {
      if (node.elements.length) fail(node, "only empty array literals");
      emit("NEWARR"); return true;
    }

    if (ts.isElementAccessExpression(node)) {                 // x[i]
      if (!expr(node.expression)) fail(node, "no value");
      if (!expr(node.argumentExpression)) fail(node, "no value");
      emit("ARRGET"); return true;
    }

    if (ts.isPropertyAccessExpression(node)) {                // x.length
      if (node.name.text === "length") { if (!expr(node.expression)) fail(node, "no value"); emit("ARRLEN"); return true; }
      fail(node, "unsupported property");
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const name = `${callee.expression.getText(sf)}.${callee.name.text}`;
        if (name in RESOURCES) {                              // db.query / DOM.renderList
          node.arguments.forEach((a) => { if (!expr(a)) fail(a, "no value"); });
          emit("RES", RESOURCES[name], node.arguments.length);
          return true;
        }
        if (callee.name.text === "push") {                    // arr.push(v)
          if (!expr(callee.expression)) fail(node, "no value");
          if (node.arguments.length !== 1) fail(node, "push expects 1 arg");
          if (!expr(node.arguments[0])) fail(node, "no value");
          emit("ARRPUSH");
          return false;
        }
      }
      fail(node, "unsupported call");
    }

    fail(node, "unsupported expression");
  }

  function stmt(node) {
    if (ts.isBlock(node)) { node.statements.forEach(stmt); return; }

    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (!d.initializer) fail(d, "declarations need an initializer");
        if (!expr(d.initializer)) fail(d, "initializer has no value");
        emit("STORE", local(d.name.text));
      }
      return;
    }

    if (ts.isExpressionStatement(node)) {
      if (expr(node.expression)) emit("POP"); // discard an unused value
      return;
    }

    if (ts.isForStatement(node)) {
      // init
      const init = node.initializer;
      if (init && ts.isVariableDeclarationList(init)) {
        for (const d of init.declarations) {
          if (!d.initializer) fail(d, "for-init needs initializer");
          if (!expr(d.initializer)) fail(d, "no value");
          emit("STORE", local(d.name.text));
        }
      } else if (init) { if (expr(init)) emit("POP"); }
      const loop = label("loop"), end = label("end");
      mark(loop);
      if (!node.condition || !expr(node.condition)) fail(node, "for needs a condition");
      emit("JMPF", end);
      stmt(node.statement);
      if (node.incrementor && expr(node.incrementor)) emit("POP");
      emit("JMP", loop);
      mark(end);
      return;
    }

    if (ts.isIfStatement(node)) {
      if (!expr(node.expression)) fail(node, "if needs a condition value");
      const els = label("else"), end = label("end");
      emit("JMPF", node.elseStatement ? els : end);
      stmt(node.thenStatement);
      if (node.elseStatement) { emit("JMP", end); mark(els); stmt(node.elseStatement); }
      mark(end);
      return;
    }

    if (ts.isReturnStatement(node)) {
      if (!node.expression || !expr(node.expression)) fail(node, "return needs a value");
      emit("RET");
      return;
    }

    fail(node, "unsupported statement");
  }

  stmt(fn.body);
  if (out[out.length - 1]?.[0] !== "RET") emit("PUSH", 0), emit("RET"); // implicit return 0
  return { asm: out, locals: Object.fromEntries(locals) };
}
