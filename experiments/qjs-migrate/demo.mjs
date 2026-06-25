// Demo: migrate a SUSPENDED SYNCHRONOUS QuickJS computation across instances.
//
// A synchronous JS function (no async / no await) references a host `db_query(...)`
// mid-computation. We suspend QuickJS right there — capturing its live C call stack
// via an asyncify unwind into a linear-memory buffer — snapshot the whole linear
// memory, restore it into a SECOND, fresh instance that never ran the program, hand
// that instance the DB result, and resume. The destination finishes the original
// computation. This is the "suspend at a DB/DOM reference, resume in another
// process, even in synchronous code" capability.
//
// Run:  node demo.mjs

import factory from "./qjsmig.mjs";

const ASTACK = 1 << 20; // asyncify buffer — holds QuickJS's unwound C stack (in linear memory)

function setup(M) {
  M._qjs_init();
  const dataPtr = M._malloc(8 + ASTACK);
  // the asyncify data struct: { current = dataPtr+8, end = dataPtr+8+ASTACK }
  new Uint32Array(M.HEAPU8.buffer, dataPtr, 2).set([dataPtr + 8, dataPtr + 8 + ASTACK]);
  M.__dataPtr = dataPtr;
  return dataPtr;
}
const writeCode = (M, code) => M.stringToUTF8(code, M._qjs_code_buf(), 16384);

async function migrate(label, program, dbResult, expect) {
  const A = await factory(); const dpA = setup(A); writeCode(A, program);
  const B = await factory(); const dpB = setup(B);   // B is fresh — it never loads the program

  // A runs until db_query suspends it (asyncify unwinds A's C stack into linear memory).
  A._qjs_eval();
  A.wasmExports.asyncify_stop_unwind();

  // Migrate: snapshot A's entire linear memory and restore it into fresh B.
  const snap = new Uint8Array(A.HEAPU8.buffer.slice(0));
  B.HEAPU8.set(snap.subarray(0, B.HEAPU8.length));

  // The DB/DOM result arrives at the DESTINATION; B resumes A's suspended sync computation.
  B.__dataPtr = dpB;
  B.__dbresult = dbResult;
  B.wasmExports.asyncify_start_rewind(dpB);
  B._qjs_eval();

  const out = B._qjs_final();
  const ok = out === expect;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: A suspended @ db_query, B resumed => ${out}${ok ? "" : ` (expected ${expect})`}  [dataPtr ${dpA === dpB ? "match" : "MISMATCH"}]`);
  return ok;
}

console.log("Migration-enabled QuickJS — suspend synchronous JS at a host reference, resume in a fresh instance\n");
const results = [];
results.push(await migrate(
  "locals across the suspend",
  `function compute(){ let base=1000, tax=50; let rows=db_query(7); return base+tax+rows; } compute();`,
  42, 1092));
results.push(await migrate(
  "deeper stack + heap object + closure used after resume",
  `function fetchRow(id){ return db_query(id); }
   function compute(){ const acct={base:1000,tax:50}; const add=(a,b)=>a+b; let rows=fetchRow(7); return add(acct.base+acct.tax, rows); }
   compute();`,
  42, 1092));
results.push(await migrate(
  "loop state carried across the migrate",
  `function compute(){ let sum=0; for(let i=1;i<=5;i++) sum+=i; let extra=db_query(99); for(let i=6;i<=8;i++) sum+=i; return sum+extra; } compute();`,
  1000, 1036));

const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — a synchronous QuickJS continuation (C stack + heap) migrates across instances`);
process.exit(ok ? 0 : 1);
