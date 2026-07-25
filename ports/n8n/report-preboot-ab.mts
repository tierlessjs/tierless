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

const field = (key: keyof Row, label: string, fmt: (n: number) => string): { on: number; off: number } => {
  const on = median(armTotals(arms.on, key));
  const off = median(armTotals(arms.off, key));
  const d = on - off;
  const pct = off ? ((d / off) * 100).toFixed(1) : "n/a";
  console.log(`${label.padEnd(22)} ON ${fmt(on).padStart(12)}   OFF ${fmt(off).padStart(12)}   ON-OFF ${fmt(d).padStart(12)}  (${pct}%)`);
  return { on, off };
};

const ws = field("wireWsOut", "ws bytes gateway->page", mb);
field("wireWsIn", "ws bytes page->gateway", mb);
field("wireApiIn", "http bytes in (+assets)", mb);
field("wireApiOut", "http bytes out", mb);
const time = field("durationMs", "wall (sum of tests)", (n) => (n / 1000).toFixed(1) + " s");

console.log();
const sessions = passedEverywhere.size;   // one fresh context per test in this harness
console.log(ws.on > ws.off
  ? `SUSPECT CONFIRMED: preboot ships ${mb(ws.on - ws.off)} the page never used across ${sessions} sessions (${mb((ws.on - ws.off) / sessions)}/session), buying ${((time.off - time.on) / 1000).toFixed(1)} s of wall.`
  : `SUSPECT CLEARED: preboot is not shipping unused cargo here (ON is ${mb(ws.off - ws.on)} CHEAPER than OFF), and costs ${((time.off - time.on) / 1000).toFixed(1)} s of wall.`);
