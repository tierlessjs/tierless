// Probe: the canonical render demo (examples/shared/app.ts) compiled to native
// wasm — runs, and migrates. This is the headline Stackmix program (query a
// dataset on the server, filter it, render the small result on the client),
// now compiled instead of interpreted: db.query returns a number[], the loop
// filters by a threshold into a growable `matched` array, and DOM.renderList
// (fired inside a nested call) renders it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileTsToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, tagInt, untagInt, hostArray, hostArrayValues } from "#stackmix/wasm/aot.mjs";
import { DATA_PTR, STACK_BASE, STACK_END } from "#stackmix/wasm/heapwire.mjs";

const src = readFileSync(fileURLToPath(new URL("../../examples/shared/app.ts", import.meta.url)), "utf8");
const bytes = compileTsToWasm(src, { entry: "render" });

const ROWS = Array.from({ length: 20 }, (_, i) => i);     // the "dataset"
const THRESH = 15;
const EXPECTED = ROWS.filter((v) => v >= THRESH);          // [15, 16, 17, 18, 19]

const seti32 = (mem, a, v) => new DataView(mem.buffer).setInt32(a, v, true);
const results = [];
const check = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };

function instance(handlers) {
  const holder = {};
  const env = {};
  for (const [k, f] of Object.entries(handlers)) env[k] = (...a) => f(holder.ex, ...a);
  holder.ex = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env }).exports;
  return holder.ex;
}

// --- single instance: both resources local -> filter + render, no migration ---
{
  const rendered = [];
  const ex = instance({
    "db.query": (e) => hostArray(e.memory, ROWS),
    "DOM.renderList": (e, items) => { const xs = hostArrayValues(e.memory, items); rendered.push(...xs); return tagInt(xs.length); },
  });
  seti32(ex.memory, BUMP_ADDR, HEAP_BASE);
  const r = untagInt(ex.render(tagInt(THRESH)));
  check(`render() native: returned ${r}, rendered ${JSON.stringify(rendered)}`, r === EXPECTED.length && JSON.stringify(rendered) === JSON.stringify(EXPECTED));
}

// --- migration: filter on A (has db.query), render on B (has DOM.renderList) ---
{
  const rendered = [];
  const A = instance({
    "db.query": (e) => hostArray(e.memory, ROWS),
    "DOM.renderList": (e) => { e.asyncify_start_unwind(DATA_PTR); return 0; },   // A lacks DOM -> migrate
  });
  seti32(A.memory, BUMP_ADDR, HEAP_BASE);
  seti32(A.memory, DATA_PTR, STACK_BASE);
  seti32(A.memory, DATA_PTR + 4, STACK_END);
  A.render(tagInt(THRESH));
  A.asyncify_stop_unwind();
  const blob = JSON.parse(JSON.stringify(Array.from(new Uint8Array(A.memory.buffer, 0, STACK_END))));

  const B = instance({
    "db.query": () => 0, // already run on A; not re-entered on rewind
    "DOM.renderList": (e, items) => { if (e.asyncify_get_state() === 2) e.asyncify_stop_rewind(); const xs = hostArrayValues(e.memory, items); rendered.push(...xs); return tagInt(xs.length); },
  });
  new Uint8Array(B.memory.buffer).set(Uint8Array.from(blob));
  B.asyncify_start_rewind(DATA_PTR);
  const r = untagInt(B.render(tagInt(THRESH)));
  check(`render() migrated A->B: returned ${r}, rendered ${JSON.stringify(rendered)}`, r === EXPECTED.length && JSON.stringify(rendered) === JSON.stringify(EXPECTED));
}

const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the render demo (app.ts) compiled to native wasm, ran, and migrated`);
process.exit(ok ? 0 : 1);
