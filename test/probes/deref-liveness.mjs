// Probe: the --auto-deref LIVENESS pass (transform.cjs insertDerefGuards). Every read of a data-resource
// local is guarded `if (isHandle(L)) L = deref(L)` so the first touch fetches it. But once L is
// materialized it stays a plain object until a HOP — only a tier migration can re-excise a big local back
// into a handle — so within a straight-line run with no hop between, repeated reads need just ONE guard.
// The pass prunes the redundant ones while keeping every guard that a hop or a control-flow join makes
// necessary, so it stays exactly correct (the heap-auto / heap-write end-to-end proofs are the runtime
// backstop; this probe pins the guard COUNT on the shapes that matter).
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TX = fileURLToPath(new URL("../../packages/stackmix/src/transform.cjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "deref-liveness-"));
let n = 0;
const guardsFor = (src) => {
  const inF = join(dir, `s${n}.src.js`), outF = join(dir, `s${n}.gen.mjs`); n++;
  writeFileSync(inF, src);
  execFileSync(process.execPath, [TX, inF, outF, "--bare", "--auto-deref"], { cwd: ROOT });
  return (readFileSync(outF, "utf8").match(/"@deref"/g) || []).length;     // one match per emitted deref guard
};

let pass = 0, fail = 0;
const check = (label, cond, got) => { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label} (got ${got})`); } };

console.log("Probe: --auto-deref liveness — prune guards dominated by an earlier guard with no hop between\n");

const a = guardsFor(`
function V(){ const rows = api.getRows(); const a = rows.length; const b = rows[0]; const c = rows[1]; return a+b+c; }`);
check("3 consecutive reads of one handle -> 1 guard (not 3)", a === 1, a);

const b = guardsFor(`
function V(){ const rows = api.getRows(); const a = rows.length; commit({a}); const b = rows[0]; return a+b; }`);
check("a tier hop (commit) between reads forces a re-guard (2 guards)", b === 2, b);

const c = guardsFor(`
function helper(){ return api.ping(); }
function V(){ const rows = api.getRows(); const a = rows[0]; helper(); const b = rows[1]; return a+b; }`);
check("a suspendable call between reads forces a re-guard (it can hop inside its sub-frame)", c === 2, c);

const d = guardsFor(`
function V(){ const rows = api.getRows(); const a = rows[0]; if (a) { const b = rows[1]; return b; } return a; }`);
check("reads in a separate block re-guard (no availability carried across a join)", d === 2, d);

const e = guardsFor(`
function pureAdd(x){ return x+1; }
function V(){ const rows = api.getRows(); const a = rows.length; pureAdd(a); const b = rows[0]; return a+b; }`);
check("a pure call does NOT re-excise, so it does not break a run (1 guard)", e === 1, e);

const ok = fail === 0;
console.log(ok
  ? `\nPASS — the --auto-deref liveness pass prunes redundant guards within a straight-line run and re-guards after any hop (tier resource or suspendable call) or control-flow join (${pass} checks)`
  : `\nFAIL (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
