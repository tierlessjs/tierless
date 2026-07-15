// The standard measured result for a port — ALL arms, both reports, one command
// (docs/corpus.md run protocol). A port's numbers are not "done" until this has run:
// bytes alone (report.mts) is half the headline; network wait (report-time.mts) is the
// half a flow rewrite actually targets, and it needs the shaped arms. Wiring this as
// one driver is why every port reports both, instead of whoever remembers to.
//
//   node ports/drive-arms.mts <name> [--rtt 80]
//
// Prereq: both trees built — `bash ports/<name>/setup.sh` and `... --baseline`.
// Runs six arms (idempotent — skips any whose results file exists), checkpoint-commits
// each, then prints the byte A/B and the network-wait decomposition:
//
//   floor  = plain suite (RTT0, no relay)         -> results/{floor,cert}-* : timing floor
//   truth  = TIERLESS_WIRE_TRUTH=1 (counting relay)-> results/*-truth.jsonl  : TCP-true bytes
//   rtt    = TIERLESS_RTT_MS=<rtt> (latency proxy) -> results/rtt<rtt>-*     : shaped timing
//
//   net = dur(rtt) - dur(floor)   (report-time.mts) — the improvable component
//
// Each arm is a full suite run; at RTT this is long. Every arm commits+pushes on
// completion, so an interrupted drive resumes where it stopped.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith("--"));
const rtt = Number((argv[argv.indexOf("--rtt") + 1] as string) || 80);
if (!name) { console.error("usage: node ports/drive-arms.mts <name> [--rtt 80]"); process.exit(2); }

const recipeDir = path.join(ROOT, name);
const resultsDir = path.join(recipeDir, "results");
const suite = path.join(recipeDir, "suite.mts");
if (!existsSync(suite)) { console.error(`no suite at ${suite}`); process.exit(2); }

const rows = (f: string): number => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0);
const sweep = (): void => {
  // scoped teardown between arms: only this port's processes (work tree + gateway),
  // never a developer's unrelated jobs. suite.mts tears its own app down on exit; this
  // catches stragglers before the next arm claims the ports.
  for (const pat of [`ports/work/${name}`, `${name}/gateway.mts`]) spawnSync("pkill", ["-9", "-f", pat]);
  spawnSync("sleep", ["3"]);
};

// one arm: run the suite for a variant with an env knob, copy its measure file to
// results, checkpoint-commit. Skips if the results file already exists (resume).
function arm(label: string, variant: "" | "--baseline", env: Record<string, string>, measureFile: string, resultFile: string): void {
  const dest = path.join(resultsDir, resultFile);
  if (existsSync(dest)) { console.log(`[drive] ${label}: ${resultFile} exists (${rows(dest)} rows) — skip`); return; }
  console.log(`\n[drive] ${label}: running ${variant || "ported"} arm…`);
  sweep();
  spawnSync(process.execPath, [suite, ...(variant ? [variant] : [])], {
    cwd: ROOT.replace(/\/ports\/$/, ""), stdio: "inherit",
    env: { ...process.env, ...env },
  });
  const work = path.join(ROOT, "work", name + (variant ? "-baseline" : ""), measureFile);
  if (rows(work) === 0) { console.error(`[drive] ${label}: no rows in ${work} — arm failed`); process.exit(1); }
  copyFileSync(work, dest);
  try {
    execFileSync("git", ["add", dest], { cwd: ROOT.replace(/\/ports\/$/, "") });
    execFileSync("git", ["-c", "user.email=noreply@anthropic.com", "-c", "user.name=Claude",
      "commit", "-m", `ports/${name}: ${label} arm (${rows(dest)} rows)`], { cwd: ROOT.replace(/\/ports\/$/, ""), stdio: "inherit" });
    for (let i = 0; i < 4; i++) { const r = spawnSync("git", ["push"], { cwd: ROOT.replace(/\/ports\/$/, ""), stdio: "inherit" }); if (r.status === 0) break; spawnSync("sleep", [String(2 << i)]); }
  } catch { console.log(`[drive] ${label}: nothing to commit (already committed?)`); }
  console.log(`[drive] ${label}: ${resultFile} (${rows(dest)} rows) committed`);
}

// FLOOR (RTT0, no relay) — the timing baseline for the net-wait subtraction
arm("floor-baseline", "--baseline", {}, "measure.jsonl", "floor-baseline.jsonl");
arm("floor-ported", "", {}, "measure.jsonl", "floor-ported.jsonl");
// TRUTH (TCP-true bytes)
arm("truth-baseline", "--baseline", { TIERLESS_WIRE_TRUTH: "1" }, "measure-truth.jsonl", "baseline-truth.jsonl");
arm("truth-ported", "", { TIERLESS_WIRE_TRUTH: "1" }, "measure-truth.jsonl", "ported-truth.jsonl");
// RTT (shaped timing)
arm(`rtt${rtt}-baseline`, "--baseline", { TIERLESS_RTT_MS: String(rtt) }, `measure-rtt${rtt}.jsonl`, `rtt${rtt}-baseline.jsonl`);
arm(`rtt${rtt}-ported`, "", { TIERLESS_RTT_MS: String(rtt) }, `measure-rtt${rtt}.jsonl`, `rtt${rtt}-ported.jsonl`);

const R = (f: string): string => path.join(resultsDir, f);
console.log("\n================ BYTES (report.mts, truth arms) ================");
spawnSync(process.execPath, [path.join(ROOT, "report.mts"), R("baseline-truth.jsonl"), R("ported-truth.jsonl")], { stdio: "inherit" });
console.log(`\n================ NETWORK WAIT (report-time.mts, floor vs rtt${rtt}) ================`);
spawnSync(process.execPath, [path.join(ROOT, "report-time.mts"), R("floor-baseline.jsonl"), R("floor-ported.jsonl"), R(`rtt${rtt}-baseline.jsonl`), R(`rtt${rtt}-ported.jsonl`)], { stdio: "inherit" });
