// Probe: does an IR program *compiled* to wasm keep a serializable, migratable
// continuation — across control flow, a heap pointer, AND a tagged value model?
// And is the tagged heap self-describing enough to WALK (the §5 prerequisite)?
//
// Values are low-bit tagged by the AOT compiler: ints are (n<<1), heap pointers
// are (addr|1), heap objects carry a length header. So host code reads/writes
// values through tagInt/untagInt, and a plain walker can reconstruct an object
// graph from the tags alone — which is what §5 needs to decide ship-vs-handle.

import { compileToWasm, BUMP_ADDR, HEAP_BASE, tagInt, untagInt, isPointer, pointerAddr } from "#stackmix/wasm/aot.mjs";

const DATA_PTR = 16, STACK_BASE = 1024, STACK_END = 8192, RES = 42;

function instantiate(bytes, onResource) {
  const holder = {};
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { resource: () => onResource(holder.ex) } });
  holder.ex = inst.exports;
  return inst.exports;
}
const seti32 = (mem, a, v) => new DataView(mem.buffer).setInt32(a, v, true);
const geti32 = (mem, a) => new DataView(mem.buffer).getInt32(a, true);

const baseline = (bytes) => { const ex = instantiate(bytes, () => tagInt(RES)); seti32(ex.memory, BUMP_ADDR, HEAP_BASE); return untagInt(ex.main()); };

function migrate(bytes, suspendOnCall) {
  let calls = 0;
  const A = instantiate(bytes, (ex) => { calls++; if (calls === suspendOnCall) { ex.asyncify_start_unwind(DATA_PTR); return 0; } return tagInt(RES); });
  seti32(A.memory, BUMP_ADDR, HEAP_BASE);
  seti32(A.memory, DATA_PTR, STACK_BASE);
  seti32(A.memory, DATA_PTR + 4, STACK_END);
  A.main();
  A.asyncify_stop_unwind();
  const shipped = JSON.parse(JSON.stringify(Array.from(new Uint8Array(A.memory.buffer, 0, STACK_END))));

  const B = instantiate(bytes, (ex) => { if (ex.asyncify_get_state() === 2) ex.asyncify_stop_rewind(); return tagInt(RES); });
  new Uint8Array(B.memory.buffer).set(Uint8Array.from(shipped));
  B.asyncify_start_rewind(DATA_PTR);
  return untagInt(B.main());
}

const results = [];
const check = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };

// --- 1. straight-line: main() = y + (x + resource) = 100 + (10 + 42) = 152 ----
const straight = {
  inner: { argc: 0, nlocals: 2, code: [["PUSH", 10], ["STORE", 0], ["RES", "resource", 0], ["STORE", 1], ["LOAD", 0], ["LOAD", 1], ["ADD"], ["RET"]] },
  main: { argc: 0, nlocals: 2, code: [["PUSH", 100], ["STORE", 0], ["CALL", "inner", 0], ["STORE", 1], ["LOAD", 0], ["LOAD", 1], ["ADD"], ["RET"]] },
};
const sBytes = compileToWasm(straight, { entry: "main", resources: ["resource"] });
check(`straight-line baseline == 152`, baseline(sBytes) === 152);
check(`straight-line continuation resumed in a FRESH instance == 152`, migrate(sBytes, 1) === 152);

// --- 2. loop: acc += resource() three times -> 126; suspend on the 2nd pass ---
const loop = {
  main: { argc: 0, nlocals: 2, code: [
    ["PUSH", 0], ["STORE", 0], ["PUSH", 0], ["STORE", 1],
    "loop", ["LOAD", 1], ["PUSH", 3], ["LT"], ["JMPF", "end"],
    ["RES", "resource", 0], ["LOAD", 0], ["ADD"], ["STORE", 0],
    ["LOAD", 1], ["PUSH", 1], ["ADD"], ["STORE", 1], ["JMP", "loop"],
    "end", ["LOAD", 0], ["RET"],
  ] },
};
const lBytes = compileToWasm(loop, { entry: "main", resources: ["resource"] });
check(`loop baseline (3x resource) == 126`, baseline(lBytes) === 126);
check(`MID-loop continuation resumed in a FRESH instance == 126`, migrate(lBytes, 2) === 126);

// --- 3. heap: p=alloc(2); p[0]=10; p[1]=30; r=resource(); return p[0]+p[1]+r=82 -
const heap = {
  main: { argc: 0, nlocals: 1, code: [
    ["PUSH", 2], ["ALLOC"], ["STORE", 0],
    ["LOAD", 0], ["PUSH", 0], ["PUSH", 10], ["ASET"], ["LOAD", 0], ["PUSH", 1], ["PUSH", 30], ["ASET"],
    ["RES", "resource", 0],
    ["LOAD", 0], ["PUSH", 0], ["AGET"], ["ADD"], ["LOAD", 0], ["PUSH", 1], ["AGET"], ["ADD"], ["RET"],
  ] },
};
const hBytes = compileToWasm(heap, { entry: "main", resources: ["resource"] });
check(`heap baseline (alloc + fields + resource) == 82`, baseline(hBytes) === 82);
check(`continuation holding a heap POINTER resumed in a FRESH instance == 82`, migrate(hBytes, 1) === 82);

// --- 4. the tagged heap is self-describing: build a nested graph, walk it -----
//   inner = [99]; outer = [7, inner]; return outer.  A walker following only the
//   value tags + length headers must reconstruct [7, [99]] — telling the int
//   field from the pointer field and following the pointer. That is exactly what
//   the §5 encoder needs to decide what travels inline vs. becomes a handle.
const graph = {
  main: { argc: 0, nlocals: 2, code: [
    ["PUSH", 1], ["ALLOC"], ["STORE", 0], ["LOAD", 0], ["PUSH", 0], ["PUSH", 99], ["ASET"],       // inner = [99]
    ["PUSH", 2], ["ALLOC"], ["STORE", 1], ["LOAD", 1], ["PUSH", 0], ["PUSH", 7], ["ASET"],        // outer[0] = 7
    ["LOAD", 1], ["PUSH", 1], ["LOAD", 0], ["ASET"],                                               // outer[1] = inner (pointer)
    ["LOAD", 1], ["RET"],                                                                          // return outer
  ] },
};
const gEx = instantiate(compileToWasm(graph, { entry: "main", resources: [] }), () => 0);
seti32(gEx.memory, BUMP_ADDR, HEAP_BASE);
const root = gEx.main();
const walk = (v) => {
  if (!isPointer(v)) return untagInt(v);                                    // int leaf
  const addr = pointerAddr(v), len = geti32(gEx.memory, addr);             // length header
  return Array.from({ length: len }, (_, i) => walk(geti32(gEx.memory, addr + 4 + i * 4)));
};
check(`tagged heap is walkable from tags alone: outer == [7, [99]]`, JSON.stringify(walk(root)) === JSON.stringify([7, [99]]));

const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — an IR-compiled continuation serialized and resumed in a fresh instance, across control flow, a heap pointer, and a tagged self-describing heap`);
process.exit(ok ? 0 : 1);
