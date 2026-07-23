// The wire budget: every megabyte of a measured arm-pair assigned to a path, the two
// arms compared per path, and whatever the instruments could NOT assign shown as its
// own row against the TCP-true totals. Attribution as a table read, not an inference —
// built after an aggregate-ratio argument misattributed n8n's +8% byte delta
// (ports/n8n/README.md byte section).
//
//   node ports/wire-budget.mts --baseline-http b.jsonl --ported-http p.jsonl \
//     [--session s.jsonl] [--baseline-tcp N] [--ported-tcp N] [--group] [--top 30]
//
// Inputs: http-log-proxy JSONL per arm (HTTP-message bytes as forwarded); the gateway's
// TIERLESS_WIRE_LOG JSONL for the ported arm's session socket (PRE-deflate plaintext —
// labeled as such; preboot cargo appears per path via the hello decomposition, marked
// [preboot]); optional TCP totals from the counting relay / --wire-truth endpoint for
// the reconciliation rows.
import { readFileSync } from "node:fs";

interface Row { http0: number; http1: number; sess: number; preboot: number; n0: number; n1: number }

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string): boolean => process.argv.includes(name);
const jsonl = (f: string): Array<Record<string, unknown>> => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

// One key per endpoint: ids and uuids collapse so "the same endpoint across runs" is
// one row (--group also collapses query strings; ungrouped keeps them — pagination
// variants are distinct cargo).
const norm = (p: string, group: boolean): string => {
  let s = p.split("#")[0];
  if (group) s = s.split("?")[0];
  s = s.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/:id");
  s = s.replace(/\/[A-Za-z0-9]{15,}(?=\/|$)/g, "/:id");
  s = s.replace(/\/\d+(?=\/|$)/g, "/:n");
  return s;
};

const B = (f?: string): Array<Record<string, unknown>> => (f ? jsonl(f) : []);
const group = has("--group");
const top = Number(arg("--top") ?? 30);
const rows = new Map<string, Row>();
const row = (k: string): Row => { let r = rows.get(k); if (!r) { r = { http0: 0, http1: 0, sess: 0, preboot: 0, n0: 0, n1: 0 }; rows.set(k, r); } return r; };

let http0Total = 0, http1Total = 0;
for (const l of B(arg("--baseline-http"))) { const r = row(norm(String(l.path), group)); const b = Number(l.reqBytes) + Number(l.respBytes); r.http0 += b; r.n0++; http0Total += b; }
for (const l of B(arg("--ported-http"))) { const r = row(norm(String(l.path), group)); const b = Number(l.reqBytes) + Number(l.respBytes); r.http1 += b; r.n1++; http1Total += b; }

// session: exec request/reply pairs land on their api path; hello preboot cargo lands
// on its path marked separately; everything else (frames without a path — hello base,
// §5 traffic, machine messages) stays visible as [session:unattributed-<kind>]
let sessTotal = 0;
for (const l of B(arg("--session"))) {
  const n = Number(l.n);
  if (l.t === "preboot") { row(norm(String(l.p), group)).preboot += n; continue; }   // duplicate of the hello frame's bytes: NOT added to sessTotal
  sessTotal += n;
  if (l.p !== undefined) row(norm(String(l.p), group)).sess += n;
  else row(`[session:${String(l.t ?? l.k ?? "?")}]`).sess += n;
}

const fmt = (n: number): string => (n === 0 ? "" : (n / 1e6).toFixed(n >= 1e6 ? 0 : 2));
const all = [...rows.entries()].map(([k, r]) => ({ k, ...r, delta: r.http1 + r.sess - r.http0 }));
all.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
console.log("Per-path wire budget (MB; session = PRE-deflate plaintext, [preboot] = per-path share of the hello frame, informational)");
console.log("path".padEnd(64) + "baseHTTP".padStart(9) + "portHTTP".padStart(9) + "session".padStart(9) + "preboot".padStart(9) + "delta".padStart(9) + "  n0/n1");
for (const r of all.slice(0, top)) {
  console.log(r.k.slice(0, 63).padEnd(64) + fmt(r.http0).padStart(9) + fmt(r.http1).padStart(9) + fmt(r.sess).padStart(9) + fmt(r.preboot).padStart(9) + fmt(r.delta).padStart(9) + `  ${r.n0}/${r.n1}`);
}
const shown = all.slice(0, top), rest = all.slice(top);
if (rest.length) {
  const s = (f: (r: typeof all[0]) => number): number => rest.reduce((a, r) => a + f(r), 0);
  console.log(`[${rest.length} more paths]`.padEnd(64) + fmt(s((r) => r.http0)).padStart(9) + fmt(s((r) => r.http1)).padStart(9) + fmt(s((r) => r.sess)).padStart(9) + fmt(s((r) => r.preboot)).padStart(9) + fmt(s((r) => r.delta)).padStart(9));
}
console.log("TOTAL".padEnd(64) + fmt(http0Total).padStart(9) + fmt(http1Total).padStart(9) + fmt(sessTotal).padStart(9));
console.log(`\narm delta (attributed): ${((http1Total + sessTotal - http0Total) / 1e6).toFixed(1)} MB — session column is plaintext; the TCP reconciliation below is the honest total`);

// reconciliation: what the instruments assigned vs what actually crossed the wire.
// A large unattributed share means the budget is missing a channel, not that the
// bytes don't exist.
const tcp0 = Number(arg("--baseline-tcp") ?? NaN), tcp1 = Number(arg("--ported-tcp") ?? NaN);
if (!Number.isNaN(tcp0)) console.log(`baseline: TCP-true ${(tcp0 / 1e6).toFixed(0)} MB vs HTTP-message ${(http0Total / 1e6).toFixed(0)} MB -> ${((tcp0 - http0Total) / 1e6).toFixed(1)} MB unattributed (framing/TLS/keep-alive/other channels)`);
if (!Number.isNaN(tcp1)) console.log(`ported:   TCP-true ${(tcp1 / 1e6).toFixed(0)} MB vs HTTP-message+session-plaintext ${((http1Total + sessTotal) / 1e6).toFixed(0)} MB (plaintext OVERSTATES the deflated ws — a session share below TCP is expected)`);
