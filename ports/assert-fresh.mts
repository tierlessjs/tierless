// A MEASURED ARM MUST NOT RUN A STALE BUNDLE. This refuses to start one.
//
// A ported arm runs an application bundle that embedded tierless AT BUILD TIME. Edit the
// framework, forget to rebuild the app, and the arm silently measures the OLD framework
// while every local check passes — the unit tests test the source, the probes test the
// source, and only the artifact is wrong. It has happened three times:
//
//   - n8n's @n8n/rest-api-client dist: an ablation ran against a bundle without the change
//     and its result had to be voided after the fact;
//   - the gateway's compiled bin: a corrected regex never reached the running gateway, so
//     a new advisory rule looked broken for three debugging rounds;
//   - n8n's editor-ui bundle: caught only because the failure was fresh in mind.
//
// packages/tierless/scripts/stamp.mjs writes a hash of the framework's own sources into
// the package on every build, and configureTierless assigns it to a page global so no
// bundler can tree-shake it away. This compares that literal against the current sources.
// Same discipline as ports/run.mts's treeHash: content identity, checked not assumed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHash } from "../packages/tierless/scripts/stamp.mjs";

/** Every file under `dir`, recursively — bundle output is hash-named, so the check cannot
 *  know the filename and has to scan. */
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });

/** Throw unless a built artifact under `dir` carries the CURRENT tierless source hash.
 *  `rebuild` is the exact command that fixes it — an error that does not say how to fix it
 *  just becomes a second debugging session. */
export function assertFreshBuild(dir: string, rebuild: string): void {
  if (process.env.TIERLESS_SKIP_FRESH_CHECK === "1") {
    console.warn("tierless: build freshness check SKIPPED (TIERLESS_SKIP_FRESH_CHECK=1) — results from this run must not be quoted");
    return;
  }
  const want = sourceHash();
  let scanned = 0;
  let found = false;
  let stale: string | null = null;
  const STAMP = /__tierlessBuild\s*=\s*["']([0-9a-f]{16})["']/;
  for (const f of files(dir)) {
    if (!/\.(js|mjs|cjs)$/.test(f) || statSync(f).size > 64_000_000) continue;
    scanned++;
    const text = readFileSync(f, "utf8");
    if (text.includes(want)) { found = true; break; }
    const m = STAMP.exec(text);
    if (m) stale = m[1];
  }
  if (found) return;
  throw new Error(
    `STALE BUILD — this bundle was not built from the current tierless sources.\n` +
    `  bundle dir : ${dir}  (${scanned} script file(s) scanned)\n` +
    `  sources are: ${want}\n` +
    `  bundle has : ${stale ?? "no tierless stamp at all — the port patch may not be in this build"}\n` +
    `  rebuild    : ${rebuild}\n` +
    `Refusing to measure: the arm would run the old framework and the numbers would be wrong.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, ...cmd] = process.argv.slice(2);
  if (!dir) { console.error("usage: node ports/assert-fresh.mts <bundle-dir> [rebuild command...]"); process.exit(2); }
  try { assertFreshBuild(dir, cmd.join(" ") || "(see the port's README)"); console.log(`fresh: ${dir} carries tierless ${sourceHash()}`); }
  catch (e) { console.error(String((e as Error).message)); process.exit(1); }
}
