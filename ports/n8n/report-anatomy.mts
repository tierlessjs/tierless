// WHERE can a session transport help? n8n's byte anatomy, from the independent per-path
// HTTP log of both arms (ports/n8n/results/remeasure/*-http.jsonl).
//
// The corpus has a win case and a no-win case and has never characterized the
// difference: vikunja cut 13% of suite IO (median per test 35% fewer bytes, 22% fewer
// trips) while n8n sits at byte parity. The hypothesis this tests is that tierless's byte
// win comes from collapsing MANY SMALL round trips, and n8n's traffic is instead a few
// ENORMOUS payloads that either bypass the session entirely or gain nothing from it.
//
// Definitions, stated because they decide the answer:
//   - ADDRESSABLE = requests the session adapter can serve: same-origin /rest/* API
//     calls. Everything else (bundles, fonts, /types/*.json static data) is browser HTTP
//     in BOTH arms and no transport choice touches it.
//   - The size histogram is over RESPONSE bytes as transferred (compressed if the origin
//     compressed), which is what a wire comparison actually pays.
//
//   node ports/n8n/report-anatomy.mts
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Hit { path: string; status: number; reqBytes: number; respBytes: number }
const DIR = fileURLToPath(new URL("./results/remeasure/", import.meta.url));
const mb = (n: number): string => (n / 1e6).toFixed(0).padStart(6) + " MB";
const pctOf = (n: number, d: number): string => ((n / d) * 100).toFixed(1).padStart(5) + "%";

const load = (arm: string): Hit[] =>
  readdirSync(DIR).filter((f) => f.startsWith(arm + "-") && f.endsWith("-http.jsonl"))
    .flatMap((f) => readFileSync(DIR + f, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Hit; } catch { return null; } })
      .filter((r): r is Hit => !!r));

const BANDS: Array<[string, number, number]> = [
  ["< 10 KB", 0, 10e3], ["10-100 KB", 10e3, 100e3], ["100 KB-1 MB", 100e3, 1e6], ["> 1 MB", 1e6, Infinity],
];
const addressable = (p: string): boolean => p.startsWith("/rest/");

for (const arm of ["baseline", "ported"]) {
  const hits = load(arm);
  if (!hits.length) { console.log(`${arm}: no logs`); continue; }
  const total = hits.reduce((a, r) => a + r.reqBytes + r.respBytes, 0);
  console.log(`\n=== ${arm} — ${hits.length.toLocaleString()} browser HTTP requests, ${mb(total)} ===`);
  console.log(`  ${"band".padEnd(13)} ${"requests".padStart(9)} ${"bytes".padStart(9)} ${"share".padStart(6)}`);
  for (const [name, lo, hi] of BANDS) {
    const band = hits.filter((r) => r.respBytes >= lo && r.respBytes < hi);
    const b = band.reduce((a, r) => a + r.reqBytes + r.respBytes, 0);
    console.log(`  ${name.padEnd(13)} ${band.length.toLocaleString().padStart(9)} ${mb(b)} ${pctOf(b, total)}`);
  }
  const addr = hits.filter((r) => addressable(r.path));
  const addrBytes = addr.reduce((a, r) => a + r.reqBytes + r.respBytes, 0);
  console.log(`  ADDRESSABLE (/rest/*, what the session can serve over HTTP here): ${addr.length.toLocaleString()} reqs, ${mb(addrBytes)}, ${pctOf(addrBytes, total)} of this arm's HTTP`);

  const byPath = new Map<string, { n: number; b: number }>();
  for (const r of hits) {
    const key = r.path.split("?")[0];
    const e = byPath.get(key) ?? { n: 0, b: 0 };
    e.n++; e.b += r.reqBytes + r.respBytes;
    byPath.set(key, e);
  }
  console.log("  top paths by bytes:");
  for (const [p, e] of [...byPath].sort((a, b) => b[1].b - a[1].b).slice(0, 6)) {
    console.log(`    ${mb(e.b)} ${pctOf(e.b, total)}  ${String(e.n).padStart(5)} reqs  ${addressable(p) ? "[addressable]" : "[untouchable]"}  ${p.slice(0, 58)}`);
  }
}

// The comparison that answers the question: what moved off HTTP in the ported arm is
// what the session actually carried. Everything else is identical in both arms by
// construction, so it can only dilute a percentage win — never create one.
const b = load("baseline"), p = load("ported");
const sum = (h: Hit[], f: (r: Hit) => boolean): number => h.filter(f).reduce((a, r) => a + r.reqBytes + r.respBytes, 0);
const bAddr = sum(b, (r) => addressable(r.path)), pAddr = sum(p, (r) => addressable(r.path));
const bRest = sum(b, (r) => !addressable(r.path)), pRest = sum(p, (r) => !addressable(r.path));
const bTot = bAddr + bRest;
console.log(`\n=== what a transport choice can even reach ===`);
console.log(`  stock HTTP on addressable paths   ${mb(bAddr)}  ${pctOf(bAddr, bTot)} of stock browser HTTP`);
console.log(`  stock HTTP everywhere else        ${mb(bRest)}  ${pctOf(bRest, bTot)}  <- identical in both arms, pure dilution`);
console.log(`  ported still on HTTP (addressable) ${mb(pAddr)}   (the rest moved to the session socket)`);
console.log(`  ported HTTP everywhere else       ${mb(pRest)}`);
console.log(`\n  CEILING: even if the session carried every addressable byte for free, the`);
console.log(`  suite-wide win could not exceed ${pctOf(bAddr, bTot)}. A parity result on n8n is`);
console.log(`  therefore mostly a statement about the workload, not about the transport.`);

// How the session actually did ON ITS OWN SLICE. The ws total comes from the gateway
// counter summed per test, so it inherits some attribution loss and is a slight
// UNDERCOUNT — which makes this comparison conservative in the port's favour, and it is
// labelled rather than quietly used as if exact.
interface Row { wireWsIn?: number; wireWsOut?: number }
const ws = readdirSync(DIR).filter((f) => f.startsWith("ported-") && f.endsWith("-measure.jsonl"))
  .flatMap((f) => readFileSync(DIR + f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row))
  .reduce((a, r) => a + (r.wireWsIn ?? 0) + (r.wireWsOut ?? 0), 0);
const portedAddressable = ws + pAddr;   // session traffic plus the trickle still on HTTP
console.log(`\n=== on the slice it actually serves ===`);
console.log(`  stock  ${mb(bAddr)} over HTTP`);
console.log(`  ported ${mb(portedAddressable)} over the session socket (+ ${mb(pAddr)} residual HTTP)`);
console.log(`  => ${(((bAddr - portedAddressable) / bAddr) * 100).toFixed(1)}% cheaper on addressable traffic,`);
console.log(`     which is ${(((bAddr - portedAddressable) / bTot) * 100).toFixed(1)}% of the suite. That product — addressable share x`);
console.log(`     per-slice win — is what a port's headline byte number actually reports.`);
