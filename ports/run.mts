// The no-vendor port runner — rung 3 of the corpus program (docs/corpus.md).
//
// A PORT is a committed recipe, never the target's code: a sha-pinned commit, one or
// more PUBLIC zip transports for it (no API, no auth), a hash of the EXTRACTED source
// tree per transport (content is pinned — archives aren't guaranteed byte-stable, and
// different transports may legitimately differ in file set, e.g. a Go module zip strips
// .git while matching the source tree), and a series of our patches. Anyone reruns the
// port from the recipe alone:
//
//   node ports/run.mts <name>            fetch (first reachable transport) -> verify -> patch
//   node ports/run.mts <name> --baseline stock variant: test patches ONLY, in
//                                        ports/work/<name>-baseline (the control arm —
//                                        same tree, same collector, no port)
//   node ports/run.mts <name> --refetch  discard the work dir and start over
//
// Transports:
//   codeload   https://codeload.github.com/OWNER/REPO/zip/<sha>          (canonical)
//   goproxy    https://proxy.golang.org/<module>/@v/<version>.zip        (Go-module apps;
//              additionally verifiable against sum.golang.org)
//
// The target's source lands in ports/work/<name>/src (gitignored). Booting the app and
// running its journeys are per-recipe steps documented in ports/<name>/README.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Source { kind: string; zip?: string; url?: string; ref?: string }
interface Recipe {
  name: string;
  repo: string;                       // owner/repo, provenance display
  sha: string;                        // the pinned commit
  sources: Source[];                  // tried in order; first reachable wins
  treeHash: Record<string, string | null>;   // per transport kind; null = print-and-pin mode
  patches: string[];                  // the port itself, recipe-dir-relative, in order
  testPatches?: string[];             // test-side only, applied to BOTH variants: the
                                      // measurement fixture + transport-agnostic wait
                                      // accommodations (docs/corpus.md, run protocol)
}

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const [name, ...flags] = process.argv.slice(2);
if (!name) { console.error("usage: node ports/run.mts <name> [--baseline] [--refetch]"); process.exit(2); }
const baseline = flags.includes("--baseline");
const recipeDir = path.join(ROOT, name);
const recipe: Recipe = JSON.parse(readFileSync(path.join(recipeDir, "recipe.json"), "utf8"));
const work = path.join(ROOT, "work", baseline ? name + "-baseline" : name);
const src = path.join(work, "src");

// sha256 over the extracted tree: every file, sorted by relative path, as
// "<relpath>\0<contents>\0" — transport-independent content identity.
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  for (const f of walk(dir).sort((a, b) => a.localeCompare(b, "en"))) {
    h.update(path.relative(dir, f)); h.update("\0"); h.update(readFileSync(f)); h.update("\0");
  }
  return h.digest("hex");
}

if (flags.includes("--refetch")) rmSync(work, { recursive: true, force: true });

if (!existsSync(src)) {
  mkdirSync(work, { recursive: true });
  let fetched: Source | null = null;
  for (const s of recipe.sources) {
    try {
      if (s.kind === "git") {
        // git smart-http transport: shallow clone at the RELEASE TAG, then verify the
        // checkout IS the pinned commit (a moved tag fails loudly). Needed where zip
        // hosts are proxied away (some sandboxes) — the tree hash pins content either way.
        const clone = path.join(work, "clone");
        console.log(`fetching ${recipe.repo}@${recipe.sha.slice(0, 12)} via git\n  ${s.url} @ ${s.ref}`);
        execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", s.ref!, s.url!, clone], { stdio: ["ignore", "inherit", "pipe"] });
        const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        if (head !== recipe.sha) { rmSync(clone, { recursive: true, force: true }); throw new Error(`ref ${s.ref} is ${head}, recipe pins ${recipe.sha}`); }
        rmSync(path.join(clone, ".git"), { recursive: true, force: true });
        execFileSync("mv", [clone, src]);
      } else {
        const zip = path.join(work, "src.zip");
        console.log(`fetching ${recipe.repo}@${recipe.sha.slice(0, 12)} via ${s.kind}\n  ${s.zip}`);
        // curl over fetch(): it honors HTTPS_PROXY/CA everywhere this runs, sandbox or laptop.
        execFileSync("curl", ["-sSL", "--fail", "-o", zip, s.zip!], { stdio: ["ignore", "inherit", "pipe"] });
        execFileSync("unzip", ["-q", zip, "-d", path.join(work, "unzip")]);
        // strip leading directories until the tree root (codeload: one dir; goproxy: module@version under host/owner dirs)
        let top = path.join(work, "unzip");
        for (;;) {
          const entries = readdirSync(top, { withFileTypes: true });
          if (entries.length === 1 && entries[0].isDirectory()) { top = path.join(top, entries[0].name); continue; }
          break;
        }
        execFileSync("mv", [top, src]);
        rmSync(path.join(work, "unzip"), { recursive: true, force: true }); rmSync(zip, { force: true });
      }
      fetched = s;
      break;
    } catch (e) { console.log(`  ${s.kind} unreachable here — trying the next transport${e instanceof Error && e.message.includes("recipe pins") ? ` (${e.message})` : ""}`); }
  }
  if (!fetched) { console.error("no transport reachable"); process.exit(1); }
  writeFileSync(path.join(work, "TRANSPORT"), fetched.kind + "\n");
  writeFileSync(path.join(work, "TREEHASH"), treeHash(src) + "\n");   // hashed at extract time: reruns verify THIS (the tree is patched below)
}

const transport = readFileSync(path.join(work, "TRANSPORT"), "utf8").trim();
const hash = readFileSync(path.join(work, "TREEHASH"), "utf8").trim();
const pinned = recipe.treeHash[transport];
if (pinned === undefined || pinned === null) {
  console.log(`treeHash for transport "${transport}" (pin this in ${name}/recipe.json):\n  "${transport}": "${hash}"`);
  // unverified content must not flow into a measured tree by default — pinning is a
  // deliberate, one-time act (TIERLESS_PIN=1), after which every run verifies
  if (!process.env.TIERLESS_PIN) { console.error("refusing to proceed on an unpinned transport (set TIERLESS_PIN=1 while pinning)"); process.exit(1); }
} else if (hash !== pinned) {
  console.error(`TREE HASH MISMATCH (${transport}) — the fetched source is not the pinned content\n  expected ${pinned}\n  got      ${hash}`);
  process.exit(1);
} else {
  console.log(`tree verified (${transport}): ${hash.slice(0, 16)}… matches the recipe`);
}

const toApply = [...(baseline ? [] : recipe.patches), ...(recipe.testPatches ?? [])];
const appliedFile = path.join(work, "APPLIED");
const applied = new Set(existsSync(appliedFile) ? readFileSync(appliedFile, "utf8").split("\n").filter(Boolean) : []);
for (const p of toApply) {
  if (applied.has(p)) { console.log(`already applied ${p}`); continue; }
  // plain patch(1), NOT `git apply`: the work tree lives inside this repo (gitignored), and
  // git apply silently no-ops (exit 0!) on paths under an ignored directory of the enclosing
  // repository. patch -p1 is cwd-relative and repo-oblivious, and fails loudly.
  execFileSync("patch", ["-p1", "--no-backup-if-mismatch", "-i", path.join(recipeDir, p)], { cwd: src, stdio: "inherit" });
  applied.add(p);
  writeFileSync(appliedFile, [...applied].join("\n") + "\n");
  console.log(`applied ${p}`);
}
if (!toApply.length) console.log("no patches to apply");
console.log(`\nsource ready (${baseline ? "baseline" : "ported"}): ${path.relative(process.cwd(), src)}`);
if (existsSync(path.join(recipeDir, "README.md"))) console.log(`next steps: ports/${name}/README.md (boot + journeys)`);
