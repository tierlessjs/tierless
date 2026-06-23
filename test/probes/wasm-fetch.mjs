// Probe: §5 on-demand fetch in the compiled path — when the migrated program
// dereferences a handle, the big object crosses ONLY then. (the linear-memory
// analog of the JS path's handle-fetch capstone)
//
// Same shape as wasm-handle.mjs, but the resumed program DOES read through the
// handle (small[1][0] = big[0]). Compiled with handles:true, an AGET on a remote
// handle that isn't resident calls __fetch, which suspends via Asyncify; the
// receiver fetches the object from the source, writes it at the same address,
// marks it resident, and rewinds. The big object's bytes cross only on that
// deref — never on the migration.

import { compileToWasm, BUMP_ADDR, HEAP_BASE, RESIDENT_BASE, tagInt, untagInt } from "#stackmix/wasm/aot.mjs";
import { encodeContinuation, decodeContinuation, wireBytes, DATA_PTR, STACK_BASE, STACK_END } from "#stackmix/wasm/heapwire.mjs";

const RES = 42;
//   main(): big=alloc(200); big[0]=111; small=alloc(2); small[0]=5; small[1]=big;
//           r=resource(); return small[0] + small[1][0] + r   (= 5 + 111 + 42 = 158)
const program = { main: { argc: 0, nlocals: 2, code: [
  ["PUSH", 200], ["ALLOC"], ["STORE", 0], ["LOAD", 0], ["PUSH", 0], ["PUSH", 111], ["ASET"],
  ["PUSH", 2], ["ALLOC"], ["STORE", 1], ["LOAD", 1], ["PUSH", 0], ["PUSH", 5], ["ASET"], ["LOAD", 1], ["PUSH", 1], ["LOAD", 0], ["ASET"],
  ["RES", "resource", 0],
  ["LOAD", 1], ["PUSH", 0], ["AGET"], ["ADD"],                                  // + small[0]
  ["LOAD", 1], ["PUSH", 1], ["AGET"], ["PUSH", 0], ["AGET"], ["ADD"], ["RET"],  // + small[1][0] (deref-miss -> fetch)
] } };
const bytes = compileToWasm(program, { entry: "main", resources: ["resource"], handles: true });

const seti32 = (mem, a, v) => new DataView(mem.buffer).setInt32(a, v, true);
const geti32 = (mem, a) => new DataView(mem.buffer).getInt32(a, true);

const results = [];
const check = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };

// --- A: build the heap, suspend at the RES, §5-encode (big -> handle) ----------
const A = (() => {
  const holder = {};
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: {
    resource: () => { holder.ex.asyncify_start_unwind(DATA_PTR); return 0; },
    __fetch: () => 0, // A never misses (it owns everything)
  } });
  holder.ex = inst.exports; return inst.exports;
})();
seti32(A.memory, BUMP_ADDR, HEAP_BASE);
seti32(A.memory, DATA_PTR, STACK_BASE);
seti32(A.memory, DATA_PTR + 4, STACK_END);
A.main();
A.asyncify_stop_unwind();
const wire = JSON.parse(JSON.stringify(encodeContinuation(A.memory)));

// --- B: decode, then resume; the deref of the handle fetches the big object ----
let fetchedBytes = 0, fetches = 0;
let pending = null;
const B = (() => {
  const holder = {};
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: {
    resource: () => { const e = holder.ex; if (e.asyncify_get_state() === 2) e.asyncify_stop_rewind(); return tagInt(RES); },
    __fetch: (ptr) => { const e = holder.ex; if (e.asyncify_get_state() === 2) { e.asyncify_stop_rewind(); return 0; } pending = ptr & ~3; e.asyncify_start_unwind(DATA_PTR); return 0; },
  } });
  holder.ex = inst.exports; return inst.exports;
})();
decodeContinuation(B.memory, wire);

// Fetch an object from the source A into B at the SAME address, and mark resident.
function fetchInto(addr) {
  const nbytes = (geti32(A.memory, addr) + 1) * 4;        // header length -> object size
  new Uint8Array(B.memory.buffer).set(new Uint8Array(A.memory.buffer, addr, nbytes), addr);
  new DataView(B.memory.buffer).setUint8(RESIDENT_BASE + ((addr - HEAP_BASE) >> 2), 1);
  fetchedBytes += nbytes; fetches++;
}

B.asyncify_start_rewind(DATA_PTR);
let ret;
while (true) {
  ret = B.main();                       // runs until done, or a deref-miss unwinds
  if (pending === null) break;          // completed
  B.asyncify_stop_unwind();
  fetchInto(pending);                   // the big object crosses ONLY here
  pending = null;
  B.asyncify_start_rewind(DATA_PTR);    // rewind to the deref and continue
}
const value = untagInt(ret);

const bigBytes = wire.handles.reduce((s, h) => s + h.size, 0);
check(`fetch-on-deref result == 158 (small + r migrated; big fetched)`, value === 158);
check(`migration excluded the big object: ${wireBytes(wire)} B crossed vs ${bigBytes} B kept home`, wireBytes(wire) < bigBytes && bigBytes > 400);
check(`big object crossed ONLY on the deref: 1 fetch of ${fetchedBytes} B`, fetches === 1 && fetchedBytes === bigBytes);

const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — §5 fetch: the big object crossed only when the migrated program dereferenced its handle`);
process.exit(ok ? 0 : 1);
