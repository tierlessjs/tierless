// Stackmix — frontend bridge: real TypeScript -> Stackmix IR -> native WASM.
// Wires the reference TS frontend (compile.mjs) to the AOT compiler (aot.mjs),
// so actual TS source runs as compiled WASM instead of being interpreted.
//
// compile.mjs emits a flat asm stream (one array, `fn:NAME` labels, resource
// *ids*, CALL fn:NAME) shaped for the wasm interpreter; the AOT compiler wants a
// per-function program { name: { argc, nlocals, code } }. This splits the stream
// and translates the two cross-references (resource id -> import name, fn:NAME ->
// NAME). For the numeric subset every opcode compile.mjs emits is already
// compiled by aot.mjs.

import { compile } from "./compile.mjs";
import { RESOURCES } from "./core.mjs";
import { compileToWasm } from "./aot.mjs";

const RES_NAME = Object.fromEntries(Object.entries(RESOURCES).map(([k, v]) => [v, k])); // id -> name

const translate = (ins) =>
  ins[0] === "RES" ? ["RES", RES_NAME[ins[1]], ins[2]]              // resource id -> import name
    : ins[0] === "CALL" ? ["CALL", ins[1].replace(/^fn:/, ""), ins[2]] // fn:NAME -> NAME
      : ins;

// Split compile()'s flat asm into a per-function program.
export function bridge(source, entry) {
  const { asm, fns } = compile(source, entry);
  const argcOf = Object.fromEntries(fns.map((f) => [f.name, f.argc]));
  const program = {};
  let cur = null;
  for (const item of asm) {
    if (typeof item === "string" && item.startsWith("fn:")) { cur = item.slice(3); program[cur] = { argc: argcOf[cur] ?? 0, nlocals: 0, code: [] }; continue; }
    program[cur].code.push(Array.isArray(item) ? translate(item) : item); // pass label strings through, translate instructions
  }
  for (const name in program) {                                    // nlocals = highest local slot referenced + 1
    let max = program[name].argc - 1;
    for (const ins of program[name].code) if (Array.isArray(ins) && (ins[0] === "LOAD" || ins[0] === "STORE")) max = Math.max(max, ins[1]);
    program[name].nlocals = max + 1;
  }
  return program;
}

// Real TS -> native WASM (Asyncify-instrumented). Resources default to those a
// RES actually references.
export function compileTsToWasm(source, { entry = "main", resources, handles = false } = {}) {
  const program = bridge(source, entry);
  const used = [...new Set(Object.values(program).flatMap((f) => f.code.filter((i) => Array.isArray(i) && i[0] === "RES").map((i) => i[1])))];
  return compileToWasm(program, { entry, resources: resources || used, handles });
}
