// Boot the fetched InvenTree the way THEIR frontend e2e lane does (playwright.config.ts
// webServer: `invoke dev.server` plus `invoke worker`), serving the BUILT frontend out of
// Django's STATIC_ROOT — their firefox lane's mode, and the only one where bytes mean
// anything (the default lane is a vite dev server handing out thousands of unbundled ES
// modules). Plus the session gateway on :8100 (page port + 100).
//
// Settings come from ports/work/<variant>/env.sh, which is also what the one-time setup
// steps read (ports/inventree/README.md) — one definition, no drift.
// Exports bootInvenTree() and invenTreeEnv(); run directly to boot and hold.
//
//   node ports/inventree/boot.mts [--baseline]
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, openSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VARIANT = process.argv.includes("--baseline") ? "inventree-baseline" : "inventree";
const WORK = fileURLToPath(new URL(`../work/${VARIANT}/`, import.meta.url));
const SRC = path.join(WORK, "src/");
const DATA = path.join(WORK, "data/");
export const FRONT = "http://127.0.0.1:8000";     // Django serves the built app AND the api on one origin
export const GATEWAY = "http://127.0.0.1:8100";

const serving = (url: string): Promise<boolean> => fetch(url).then(() => true, () => false);
async function waitFor(url: string, ms: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + url);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** This arm's environment: the tree's own env.sh, sourced. NUL-separated so values with
 *  newlines survive. */
export function invenTreeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dump = execFileSync("bash", ["-c", `source ${JSON.stringify(path.join(WORK, "env.sh"))} >/dev/null && env -0`], { encoding: "utf8", maxBuffer: 1 << 24 });
  const env: NodeJS.ProcessEnv = {};
  for (const line of dump.split("\0")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return { ...env, ...extra };
}

/** Restore the arm's database and media to the state `invoke dev.setup-test` left.
 *  THEIR lane gets a fresh Postgres service per CI job; a work tree does not, and the
 *  suite mutates heavily (it builds orders, edits parts, uploads attachments). Grafana
 *  taught this the expensive way: a shared data dir scored the SAME arm 97 clean and 82
 *  dirty. Both variants reset identically, so every arm starts from the same records. */
function resetData(): void {
  const db = path.join(DATA, "inventree.sqlite3");
  const pristine = path.join(DATA, "pristine/");
  if (!existsSync(path.join(pristine, "inventree.sqlite3"))) throw new Error(`no pristine snapshot in ${pristine} — run ports/inventree/setup.sh first`);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(db + suffix, { force: true });
  cpSync(path.join(pristine, "inventree.sqlite3"), db);
  rmSync(path.join(DATA, "media"), { recursive: true, force: true });
  cpSync(path.join(pristine, "media"), path.join(DATA, "media"), { recursive: true });
}

export async function bootInvenTree(): Promise<{ close(): void }> {
  if (!existsSync(path.join(DATA, "static/web/assets"))) throw new Error("frontend not built into STATIC_ROOT — invoke int.frontend-compile && invoke static in " + SRC);
  for (const url of [FRONT, GATEWAY]) {
    if (await serving(url)) throw new Error(`${url} is already serving — a stale stack owns the port; kill it before booting`);
  }
  resetData();
  const env = invenTreeEnv();
  const log = (name: string): ["ignore", number, number] => { const fd = openSync(path.join(WORK, name + ".log"), "w"); return ["ignore", fd, fd]; };
  const procs: ChildProcess[] = [
    // their webServer commands, minus the 0.0.0.0 bind (loopback only here)
    spawn("invoke", ["dev.server", "-a", "127.0.0.1:8000"], { cwd: SRC, env, stdio: log("server"), detached: true }),
    spawn("invoke", ["worker"], { cwd: SRC, env, stdio: log("worker"), detached: true }),
    // the session gateway, both variants (env symmetry; a baseline build never connects).
    // InvenTree is a cookie-auth app (Django sessionid, httpOnly) so the gateway mediates
    // cookie authority: the ws upgrade carries the cookie (cookies scope to host, not
    // port) and crossings replay it against the backend. That is what makes the axios
    // adapter's `crossCredentialed` sound here, and it also carries the csrftoken cookie
    // the adapter's XSRF header is checked against.
    spawn(process.execPath, [
      fileURLToPath(new URL("../../packages/tierless/bin/tierless.mjs", import.meta.url)), "gateway",
      "--backend", FRONT,
      "--port", "8100",
      "--cookie-authority",
      "--allow-origin", process.env.TIERLESS_ALLOWED_ORIGINS ||
        // 28000: the truth arm serves the page through the counting relay — its origin
        // must pass the ws gate or the ported arm silently measures no session
        ["8000", "18000", "28000"].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(","),
    ], { env: process.env, stdio: log("gateway"), detached: true }),
  ];
  const close = (): void => procs.forEach((p) => { try { process.kill(-p.pid!, "SIGTERM"); } catch { p.kill(); } });
  process.on("exit", close);
  // 'exit' does not fire on signal death (timeout(1) sends SIGTERM): without these, a
  // killed boot strands the DETACHED server group on :8000 for every later run
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { close(); process.exit(1); });
  try {
    await Promise.all([
      waitFor(FRONT + "/api/", 180_000),
      waitFor(GATEWAY, 60_000),
    ]);
  } catch (err) {
    close();
    throw err;
  }
  return { close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bootInvenTree();
  console.log(`inventree up: ${FRONT}, gateway ${GATEWAY} — ctrl-c to stop`);
  await new Promise(() => { /* hold until killed */ });
}
