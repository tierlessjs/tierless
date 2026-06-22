// Waso — migrate-vs-fetch, the §6 cost model with real measured sizes.
//
//   node waso-policy.mjs
//
// §6: "Always migrate to the resource is the simple rule, but it's wrong when
// the continuation is large and the result is small — sometimes you'd rather
// fetch the data back and stay put." This needs a cost comparison, kept
// empirical: cold/uninformed => migrating is the only option priced (fetch =
// infinite), which reproduces the naive "only cross when forced" behavior;
// informed => pick the smaller of (ship the continuation) vs (ship the data).
//
// We price both options with REAL bytes: the continuation size comes from an
// actual capture() of the wasm runtime; the data size is the real dataset /
// result size. We then show the decision flipping between the two regimes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "./waso-compile.mjs";
import {
  assemble, makeInstance, setEntryState, capture, restore, Suspend,
  dbQueryHandler, makeRenderHandler, fmt, RESULT, RESOURCES, N, DATASET_BYTES,
} from "./waso-wasm-core.mjs";

const bytecode = assemble(compile(readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8")).asm);

// Run render(threshold) across the two instances, recording the real captured
// continuation size at every boundary. Returns the migrations and the result.
async function runScenario(threshold) {
  const rendered = [];
  const server = await makeInstance("server", bytecode, { [RESOURCES["db.query"]]: dbQueryHandler });
  const client = await makeInstance("client", bytecode, { [RESOURCES["DOM.renderList"]]: makeRenderHandler(rendered) });
  setEntryState(client.memory, threshold);
  const migrations = [];
  let current = client, value = null;
  while (true) {
    try { current.exports.run(); value = new DataView(current.memory.buffer).getInt32(RESULT, true); break; }
    catch (e) {
      if (!(e instanceof Suspend)) throw e;
      const target = current === client ? server : client;
      const wire = capture(current.memory);
      migrations.push({ resid: e.resid, from: current.name, to: target.name, contBytes: wire.length });
      restore(target.memory, wire);
      current = target;
    }
  }
  return { migrations, value, rendered: rendered.length };
}

// The §6 decision. A side-effecting resource (DOM) can only be reached by
// migrating — there is no "fetch the DOM". A data resource (db.query) offers a
// genuine choice: migrate the continuation, or fetch the data and stay put.
const FETCHABLE = { [RESOURCES["db.query"]]: DATASET_BYTES };  // data you could pull instead
const resName = (id) => Object.keys(RESOURCES).find((k) => RESOURCES[k] === id);

function decide(contBytes, fetchBytes, mode) {
  if (mode === "cold") return { choice: "migrate", why: "fetch not yet priced (cost = infinite)" };
  if (fetchBytes === Infinity) return { choice: "migrate", why: "side effect: cannot fetch" };
  return contBytes <= fetchBytes
    ? { choice: "migrate", why: `continuation ${fmt(contBytes)} <= data ${fmt(fetchBytes)}` }
    : { choice: "fetch",   why: `data ${fmt(fetchBytes)} < continuation ${fmt(contBytes)}` };
}

console.log("Waso §6 — migrate-vs-fetch, priced with real captured continuation sizes\n");

// --- Regime 1: the §11 case — small continuation, large data ----------------
const r1 = await runScenario(999);
console.log("Regime 1: render(threshold=999) — selective filter (the §11 'stack < heap' case)");
for (const m of r1.migrations) {
  const fetchBytes = FETCHABLE[m.resid] ?? Infinity;
  const cold = decide(m.contBytes, fetchBytes, "cold");
  const informed = decide(m.contBytes, fetchBytes, "informed");
  console.log(`  ${m.from} -> ${m.to} (${resName(m.resid)}): migrate=${fmt(m.contBytes)}  ` +
    `fetch=${fetchBytes === Infinity ? "N/A" : fmt(fetchBytes)}`);
  console.log(`      cold rule    -> ${cold.choice.toUpperCase()}  (${cold.why})`);
  console.log(`      informed rule-> ${informed.choice.toUpperCase()}  (${informed.why})`);
}
console.log(`  => at db.query, shipping the ${fmt(r1.migrations[0].contBytes)} continuation beats`);
console.log(`     pulling the ${fmt(DATASET_BYTES)} dataset: both rules agree, migrate. (result ${r1.value})\n`);

// --- Regime 2: the §6 caveat — large continuation, small data ---------------
// Build a genuinely large continuation by keeping ~10% of the rows, so the
// captured continuation is most of the small working heap of live `matched`.
// (We stay under the working-heap cap, see the note printed below.) Then
// suppose the computation needs ONE more small fact from the server to finish.
const r2 = await runScenario(900); // keep ~10% of rows -> a large live `matched`
let exp2 = 0; for (let k = 0; k < N; k++) if (k % 1000 >= 900) exp2++;
if (r2.value !== exp2) throw new Error(`regime 2 miscomputed: ${r2.value} != ${exp2}`);
const bigCont = r2.migrations.find((m) => m.from === "server").contBytes; // real, ~MB
const smallFact = 16; // a 16-byte lookup the program would need next
console.log("Regime 2: a large continuation needs one small server fact (the §6 caveat)");
console.log(`  (continuation size is real: render(threshold=900) captured ${fmt(bigCont)} of live 'matched',`);
console.log(`   ${r2.value.toLocaleString()} matches, verified correct)`);
const cold2 = decide(bigCont, smallFact, "cold");
const informed2 = decide(bigCont, smallFact, "informed");
console.log(`  need a ${smallFact} B server fact: migrate=${fmt(bigCont)}  fetch=${fmt(smallFact)}`);
console.log(`      cold rule    -> ${cold2.choice.toUpperCase()}  (${cold2.why})`);
console.log(`      informed rule-> ${informed2.choice.toUpperCase()}  (${informed2.why})`);
console.log(`  => here the cold rule ships ${fmt(bigCont)}; the informed rule fetches ${fmt(smallFact)}`);
console.log(`     and stays put — a ${(bigCont / smallFact).toFixed(0)}x win once profiling has priced the fetch.\n`);

console.log("This is §6's claim, concretely: the same decision degrades to the naive");
console.log("'always migrate' when uninformed, and improves to the cheaper option with");
console.log("measured sizes — no speculative optimizer, just comparing real bytes.");
