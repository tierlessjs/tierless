// Read the preboot A/B (ports/n8n/drive-preboot-ab.sh) and price the over-delivery.
//
// The claim under test: the hello pre-fetches all 18 manifest GETs per upgrade
// regardless of what the page consumes, so the unconsumed ones are pure waste. With
// preboot OFF the page crosses only for what it wants — and those bytes are paid in
// BOTH arms, just as crossings rather than hello cargo. So the ws-byte difference
// (ON - OFF) is the wasted cargo itself, and is POSITIVE if the suspect is real.
//
// Gated on pass parity: a test that failed in one arm and passed in the other did not
// run the same work, so it cannot contribute a byte comparison. Medians across runs.
//
//   node ports/n8n/report-preboot-ab.mts
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Row { id: string; status: string; retry: number; durationMs: number; wireWsIn?: number; wireWsOut?: number; wireApiIn?: number; wireApiOut?: number }
const DIR = fileURLToPath(new URL("./results/preboot-ab/", import.meta.url));

const load = (f: string): Row[] =>
  readFileSync(DIR + f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mb = (n: number): string => (n / 1e6).toFixed(2) + " MB";

const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));
const arms = { on: files.filter((f) => f.startsWith("on-")).sort(), off: files.filter((f) => f.startsWith("off-")).sort() };
if (!arms.on.length || !arms.off.length) { console.error("need at least one run of each arm in " + DIR); process.exit(2); }

// PASS PARITY: only tests that passed in EVERY run of BOTH arms are comparable.
const runs = [...arms.on, ...arms.off].map(load);
const passedEverywhere = new Set(runs[0].filter((r) => r.status === "passed").map((r) => r.id));
for (const rows of runs.slice(1)) {
  const ok = new Set(rows.filter((r) => r.status === "passed").map((r) => r.id));
  for (const id of [...passedEverywhere]) if (!ok.has(id)) passedEverywhere.delete(id);
}
const total = new Set(runs.flatMap((rows) => rows.map((r) => r.id))).size;
console.log(`preboot A/B — ${arms.on.length} run(s) ON, ${arms.off.length} OFF, spec-level`);
console.log(`pass-parity set: ${passedEverywhere.size}/${total} tests compared\n`);

const armTotals = (fs: string[], key: keyof Row): number[] =>
  fs.map((f) => load(f).filter((r) => passedEverywhere.has(r.id)).reduce((a, r) => a + ((r[key] as number) ?? 0), 0));

// A one-run sign test is not a result: the arm-to-arm delta only means something if it
// clears the run-to-run spread WITHIN an arm. Report both, and refuse to call a delta
// that does not clear its own noise floor.
interface Delta { on: number; off: number; d: number; pct: number; noise: number; clears: boolean }
const field = (key: keyof Row, label: string, fmt: (n: number) => string): Delta => {
  const onRuns = armTotals(arms.on, key), offRuns = armTotals(arms.off, key);
  const on = median(onRuns), off = median(offRuns);
  const d = on - off;
  const spread = (xs: number[]): number => (xs.length > 1 ? Math.max(...xs) - Math.min(...xs) : NaN);
  const noise = Math.max(spread(onRuns), spread(offRuns));
  const clears = Number.isFinite(noise) && Math.abs(d) > noise;
  const pct = off ? (d / off) * 100 : NaN;
  console.log(
    `${label.padEnd(22)} ON ${fmt(on).padStart(12)}   OFF ${fmt(off).padStart(12)}   ON-OFF ${fmt(d).padStart(12)}` +
    `  (${pct.toFixed(1)}%)   within-arm spread ${Number.isFinite(noise) ? fmt(noise) : "n/a (1 run)"}${clears ? "" : "  <- does NOT clear noise"}`,
  );
  return { on, off, d, pct, noise, clears };
};

const ws = field("wireWsOut", "ws bytes gateway->page", mb);
field("wireWsIn", "ws bytes page->gateway", mb);
field("wireApiIn", "http bytes in (+assets)", mb);
field("wireApiOut", "http bytes out", mb);
const time = field("durationMs", "wall (sum of tests)", (n) => (n / 1000).toFixed(1) + " s");

// This arm injects NO latency (wire-truth and RTT shaping are mutually exclusive —
// a counting relay inflates request-heavy tests). Preboot's benefit is round trips
// SAVED, which is worth ~0 at RTT0 while its cost — 18 upstream GETs at every upgrade,
// inside the boot window — is paid in full. So a wall loss here is expected and is NOT
// evidence against the RTT80 result that motivated preboot; only the bytes transfer.
console.log(`\n(RTT0 arm: preboot's round-trip saving is worth ~0 here by construction; the BYTE line is what this run decides.)`);
const sessions = passedEverywhere.size;   // one fresh context per test in this harness
console.log(!ws.clears
  ? `BYTES: NO EFFECT that clears noise — ON-OFF ${mb(ws.d)} (${ws.pct.toFixed(1)}%) against a ${Number.isFinite(ws.noise) ? mb(ws.noise) : "not-yet-measured (1 run/arm)"} within-arm spread. Preboot over-delivery does NOT explain n8n's byte regression.`
  : ws.d > 0
    ? `BYTES: over-delivery REAL — preboot ships ${mb(ws.d)} the page never used across ${sessions} sessions (${mb(ws.d / sessions)}/session).`
    : `BYTES: preboot is CHEAPER by ${mb(-ws.d)} — it displaces more crossing overhead than its unused envelopes cost.`);
console.log(`WALL: preboot ${time.d > 0 ? "COSTS" : "saves"} ${Math.abs(time.d / 1000).toFixed(1)} s (${Math.abs(time.pct).toFixed(1)}%) at RTT0${time.clears ? "" : " — inside noise"}.`);
