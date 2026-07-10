// Build the locked §6 profile from a PROFILING run's trace (run protocol, docs/corpus.md):
//
//   node ports/build-profile.mts <trace.jsonl> <dist-tierless/> <profile.json>
//
// The profile's validity key is the MERGED app world's hash — "merged:" + the sorted
// BUNDLE_HASHes of every compiled app machine in the manifest, exactly what the browser
// computes from the modules it binds (tierless/browser mergedAppHash). A profile built
// for any other build is refused at load, never misattributed.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildProfile, type TraceRecord } from "tierless/trace";

const [traceFile, distDir, outFile] = process.argv.slice(2);
if (!traceFile || !distDir || !outFile) { console.error("usage: node ports/build-profile.mts <trace.jsonl> <dist-tierless/> <profile.json>"); process.exit(2); }

// the profile key hashes EVERY compiled module in the manifest, while the browser's key
// grows as modules bindMethods — the pending profile activates only once the page has
// loaded every compile target. Fail-safe on code-split pages that never load one: the
// comparison run stays on the fetch arm (and warns), it never runs with a partial match.
const manifest = JSON.parse(readFileSync(path.join(distDir, "tierless.manifest.json"), "utf8")) as { modules: Record<string, string> };
const hashes: string[] = [];
for (const [id, file] of Object.entries(manifest.modules)) {
  if (!id.startsWith("m:")) continue;
  const mod = await import(pathToFileURL(path.join(distDir, file)).href);
  if (typeof mod.BUNDLE_HASH === "string") hashes.push(mod.BUNDLE_HASH);
}
const bundleHash = "merged:" + hashes.sort().join("+");

const records: TraceRecord[] = readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const profile = buildProfile(records, bundleHash);
writeFileSync(outFile, JSON.stringify(profile) + "\n");

const sites = Object.entries(profile.sites);
const chains = sites.filter(([, s]) => s.modal && s.modal.length > 0 && s.stability >= 0.9);
console.log(`profile: ${records.length} records, ${profile.runs.complete}/${profile.runs.total} complete runs, ${sites.length} sites`);
console.log(`  ${chains.length} stable chain-starting sites (the ones methodMigrate will ship):`);
for (const [k, s] of chains.slice(0, 20)) console.log(`    ${k}  suffix ${s.modal!.split(">").length} more, stability ${(s.stability * 100).toFixed(0)}%`);
console.log(`  bundle ${bundleHash.slice(0, 60)}…`);
