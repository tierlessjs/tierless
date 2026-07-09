// Boot the fetched NocoDB the way THEIR CI does (.github/workflows/
// playwright-test-workflow.yml, sqlite lane, minus docker and the private S3 UI
// artifact — see README.md): nc-sql-executor sidecar on :9000, the backend via their
// watch:run:playwright script (SQLite test_noco.db, EE=true is upstream's own script)
// on :8080, and the Nuxt-built UI server on :3000. Exports bootNocodb() for the suite
// driver; run directly to boot and hold.
//
//   node ports/nocodb/boot.mts [--baseline]     (build first: bash ports/nocodb/setup.sh)
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VARIANT = process.argv.includes("--baseline") ? "nocodb-baseline" : "nocodb";
const SRC = fileURLToPath(new URL(`../work/${VARIANT}/src/`, import.meta.url));
export const API = "http://127.0.0.1:8080";
export const FRONT = "http://127.0.0.1:3000";
const EXECUTOR = "http://127.0.0.1:9000";

// any HTTP answer means the port is owned (the executor 404s its root; that still
// counts as up) — r.ok is the bar only for the readiness waits below
const serving = (url: string): Promise<boolean> => fetch(url).then(() => true, () => false);

async function waitFor(url: string, ms: number, okOnly = true): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (!okOnly || r.ok) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + url);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function bootNocodb(): Promise<{ close(): void }> {
  if (!existsSync(path.join(SRC, "packages/nc-gui/.output/server/index.mjs"))) throw new Error("frontend not built — bash ports/nocodb/setup.sh");
  // refuse ports that are already up: a stale stack would otherwise serve the run and
  // every measurement would silently test old code
  for (const url of [API, FRONT, EXECUTOR]) {
    if (await serving(url)) throw new Error(`${url} is already serving — a stale stack owns the port; kill it before booting`);
  }
  const env = { ...process.env, HUSKY: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  // detached process GROUPS: pnpm/rspack/nodemon spawn children of their own; killing
  // only the wrapper leaves a stale server owning the port. kill(-pid) takes the group.
  const procs: ChildProcess[] = [
    spawn("corepack", ["pnpm", "run", "dev"], { cwd: path.join(SRC, "packages/nc-sql-executor"), env, stdio: "ignore", detached: true }),
    spawn("corepack", ["pnpm", "run", "watch:run:playwright"], { cwd: path.join(SRC, "packages/nocodb"), env, stdio: "ignore", detached: true }),
    spawn("corepack", ["pnpm", "run", "ci:start"], { cwd: path.join(SRC, "packages/nc-gui"), env, stdio: "ignore", detached: true }),
  ];
  // the backend's first wait includes its rspack watch build (minutes); their CI polls
  // :8080 the same way. The executor answers anything (404 root = up).
  await Promise.all([
    waitFor(API, 600_000),
    waitFor(FRONT, 120_000),
    waitFor(EXECUTOR, 120_000, false),
  ]);
  const close = (): void => procs.forEach((p) => { try { process.kill(-p.pid!, "SIGTERM"); } catch { p.kill(); } });
  process.on("exit", close);
  return { close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bootNocodb();
  console.log(`nocodb up: backend ${API}, frontend ${FRONT}, executor ${EXECUTOR} — ctrl-c to stop`);
  await new Promise(() => { /* hold until killed */ });
}
