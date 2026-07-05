// The no-vendor port runner — rung 3 of the corpus program (docs/corpus.md).
//
// A PORT is a committed recipe, never the target's code: a sha-pinned public zip URL
// (no GitHub API, no auth — plain `codeload.github.com/OWNER/REPO/zip/<sha>`), a hash
// of the EXTRACTED source tree (GitHub's generated archives aren't guaranteed
// byte-stable forever, so content is pinned, not the zip), and a series of our patches.
// Anyone reruns the port from the recipe alone:
//
//   node ports/run.mts <name>            fetch -> verify tree -> apply patches
//   node ports/run.mts <name> --refetch  discard the work dir and start over
//
// The target's source lands in ports/work/<name>/src (gitignored). Booting the app and
// running its journeys stay per-recipe steps documented in ports/<name>/README.md — v1
// keeps the runner to the reproducibility core: fetch, verify, patch.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Recipe {
  name: string;
  repo: string;                       // owner/repo, for provenance display
  sha: string;                        // the pinned commit
  zip: string;                        // public sha-based zip URL (codeload)
  treeHash: string | null;            // sha256 over the extracted tree; null = print-and-pin mode
  patches: string[];                  // repo-relative to the recipe dir, git-apply format, applied in order
}

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const [name, ...flags] = process.argv.slice(2);
if (!name) { console.error("usage: node ports/run.mts <name> [--refetch]"); process.exit(2); }
const recipeDir = path.join(ROOT, name);
const recipe: Recipe = JSON.parse(readFileSync(path.join(recipeDir, "recipe.json"), "utf8"));
const work = path.join(ROOT, "work", name);
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
  console.log(`fetching ${recipe.repo}@${recipe.sha.slice(0, 12)}\n  ${recipe.zip}`);
  mkdirSync(work, { recursive: true });
  const zip = path.join(work, "src.zip");
  // curl over fetch(): it honors HTTPS_PROXY/CA everywhere this runs, sandbox or laptop.
  execFileSync("curl", ["-sSL", "--fail", "-o", zip, recipe.zip], { stdio: "inherit" });
  execFileSync("unzip", ["-q", zip, "-d", path.join(work, "unzip")]);
  const [top, ...rest] = readdirSync(path.join(work, "unzip"));
  if (!top || rest.length) throw new Error("expected a single top-level directory in the archive");
  execFileSync("mv", [path.join(work, "unzip", top), src]);
  rmSync(path.join(work, "unzip"), { recursive: true }); rmSync(zip);
}

const hash = treeHash(src);
if (recipe.treeHash === null) {
  console.log(`treeHash (pin this in ${name}/recipe.json):\n  ${hash}`);
} else if (hash !== recipe.treeHash) {
  console.error(`TREE HASH MISMATCH — the fetched source is not the pinned content\n  expected ${recipe.treeHash}\n  got      ${hash}`);
  process.exit(1);
} else {
  console.log(`tree verified: ${hash.slice(0, 16)}… matches the recipe`);
}

for (const p of recipe.patches) {
  const patch = path.join(recipeDir, p);
  execFileSync("git", ["apply", "--whitespace=nowarn", patch], { cwd: src, stdio: "inherit" });
  console.log(`applied ${p}`);
}
if (!recipe.patches.length) console.log("no patches (baseline recipe)");
console.log(`\nsource ready: ${path.relative(process.cwd(), src)}`);
if (statSync(src).isDirectory() && existsSync(path.join(recipeDir, "README.md"))) {
  console.log(`next steps: ports/${name}/README.md (boot + journeys)`);
}
