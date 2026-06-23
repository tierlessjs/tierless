// Probe: §5 in the compiled path — does a BIG object stay home while the
// continuation migrates? (the linear-memory analog of the JS path's
// "dataset never crossed", built on src/wasm/heapwire.mjs)
//
// The program builds a SMALL object whose field points at a BIG object, holds the
// small pointer across a RES, and after resuming reads only the small object's
// own field (never dereferencing the big one). Instead of shipping all of linear
// memory, we run the §5 codec: it scans the asyncify stack for roots, walks the
// heap, ships the small object inline, and replaces the big object (reachable via
// small[1]) with a handle whose bytes never travel. The result stays correct and
// the wire excludes the big object.

import { compileToWasm, BUMP_ADDR, HEAP_BASE, tagInt, untagInt } from "#stackmix/wasm/aot.mjs";
import { encodeContinuation, decodeContinuation, wireBytes, DATA_PTR, STACK_BASE, STACK_END } from "#stackmix/wasm/heapwire.mjs";

const RES = 42;
//   main(): big=alloc(200); big[0]=111; small=alloc(2); small[0]=5; small[1]=big;
//           r=resource(); return small[0] + r   (= 5 + 42 = 47; big reachable, never deref'd)
const program = { main: { argc: 0, nlocals: 2, code: [
  ["PUSH", 200], ["ALLOC"], ["STORE", 0], ["LOAD", 0], ["PUSH", 0], ["PUSH", 111], ["ASET"],   // big = alloc(200); big[0]=111
  ["PUSH", 2], ["ALLOC"], ["STORE", 1],                                                          // small = alloc(2)
  ["LOAD", 1], ["PUSH", 0], ["PUSH", 5], ["ASET"], ["LOAD", 1], ["PUSH", 1], ["LOAD", 0], ["ASET"], // small[0]=5; small[1]=big
  ["RES", "resource", 0],
  ["LOAD", 1], ["PUSH", 0], ["AGET"], ["ADD"], ["RET"],                                          // return small[0] + r
] } };
const bytes = compileToWasm(program, { entry: "main", resources: ["resource"] });

function instantiate(onResource) {
  const holder = {};
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { resource: () => onResource(holder.ex) } });
  holder.ex = inst.exports;
  return inst.exports;
}
const seti32 = (mem, a, v) => new DataView(mem.buffer).setInt32(a, v, true);

const results = [];
const check = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };

// A: cold-start, suspend at the RES, then SPLIT-encode (not ship-everything).
const A = instantiate((e) => { e.asyncify_start_unwind(DATA_PTR); return 0; });
seti32(A.memory, BUMP_ADDR, HEAP_BASE);
seti32(A.memory, DATA_PTR, STACK_BASE);
seti32(A.memory, DATA_PTR + 4, STACK_END);
A.main();
A.asyncify_stop_unwind();
const wire = JSON.parse(JSON.stringify(encodeContinuation(A.memory))); // §5 split + a JSON round-trip

// B: fresh instance; decode (the big object is NOT written), then rewind.
const B = instantiate((e) => { if (e.asyncify_get_state() === 2) e.asyncify_stop_rewind(); return tagInt(RES); });
decodeContinuation(B.memory, wire);
B.asyncify_start_rewind(DATA_PTR);
const value = untagInt(B.main());

const bigBytes = wire.handles.reduce((s, h) => s + h.size, 0);
check(`split migration result == 47 (small shipped, big handled)`, value === 47);
check(`big object stayed home (1 handle, ${bigBytes} B not shipped)`, wire.handles.length === 1 && bigBytes > 400);
check(`wire excluded the big object: ${wireBytes(wire)} B crossed vs ${bigBytes} B kept home`, wireBytes(wire) < bigBytes);

const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — §5 split: a big object stayed home while the continuation migrated`);
process.exit(ok ? 0 : 1);
