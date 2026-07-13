// Boot the fetched n8n the way THEIR e2e lane does (packages/testing/playwright:
// `pnpm test:local` webServer env + run-local-isolated's readiness check): ONE node
// process — the built cli serves the REST API and the built editor-ui from :5680,
// SQLite in a per-variant user folder. Exports bootN8n() for the suite driver; run
// directly to boot and hold.
//
//   node ports/n8n/boot.mts [--baseline]     (build first: bash ports/n8n/setup.sh)
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VARIANT = process.argv.includes("--baseline") ? "n8n-baseline" : "n8n";
const WORK = fileURLToPath(new URL(`../work/${VARIANT}/`, import.meta.url));
const SRC = path.join(WORK, "src/");
export const APP = "http://127.0.0.1:5680";      // API + editor statics, one origin
export const GATEWAY = "http://127.0.0.1:5780";  // tierless session socket (ported arm)
const BROKER_PORT = "5681";                      // task-runner broker (default 5679 may collide)

const serving = (url: string): Promise<boolean> => fetch(url).then(() => true, () => false);

// their readiness bar (run-local-isolated.mjs), tightened: POST /rest/e2e/reset until
// the CONTROLLER answers. Their non-404 check has a hole this sandbox hits: n8n's
// "starting up" middleware answers 503 before controllers mount, and the plain-Express
// window 404s "Cannot POST" — ready is only a response that is neither.
async function waitForN8n(ms: number): Promise<void> {
  const t0 = Date.now();
  let last = "connection refused";
  for (;;) {
    try {
      const r = await fetch(`${APP}/rest/e2e/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await r.text();
      last = `HTTP ${r.status}`;
      if (r.status !== 404 && !body.includes("starting up")) return;   // controller reached ({} body -> its own 4xx/5xx)
    } catch (err) { last = err instanceof Error ? err.message : String(err); }
    if (Date.now() - t0 > ms) throw new Error(`n8n not ready in ${ms}ms (last: ${last})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function bootN8n(): Promise<{ close(): void }> {
  if (!existsSync(path.join(SRC, "packages/cli/dist/index.js"))) throw new Error("not built — bash ports/n8n/setup.sh" + (VARIANT.endsWith("baseline") ? " --baseline" : ""));
  for (const url of [APP, GATEWAY]) {
    if (await serving(url)) throw new Error(`${url} is already serving — a stale stack owns the port; kill it before booting`);
  }
  // fresh state per measured run (docs/corpus.md run protocol): the SQLite db lives in
  // the user folder; global-setup's RESET_E2E_DB wipes rows, this wipes the rest
  const userFolder = path.join(WORK, "user-folder");
  rmSync(userFolder, { recursive: true, force: true });
  mkdirSync(userFolder, { recursive: true });
  const log = (name: string): ["ignore", number, number] => { const fd = openSync(path.join(WORK, name + ".log"), "w"); return ["ignore", fd, fd]; };
  // env: their test:local webServer block (playwright.config.ts), plus the isolated
  // broker port from their run-local-isolated lane
  const env = {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    DB_SQLITE_POOL_SIZE: "40",
    E2E_TESTS: "true",
    N8N_PORT: "5680",
    N8N_LISTEN_ADDRESS: "127.0.0.1",   // their default '::' needs IPv6, absent in this sandbox
    N8N_WORKER_SERVER_ADDRESS: "127.0.0.1",
    N8N_RUNNERS_BROKER_PORT: BROKER_PORT,
    N8N_USER_FOLDER: userFolder,
    N8N_LOG_LEVEL: "debug",
    N8N_METRICS: "true",
    N8N_RESTRICT_FILE_ACCESS_TO: "",
    N8N_DYNAMIC_BANNERS_ENABLED: "false",
    N8N_DIAGNOSTICS_ENABLED: "false",
  };
  // detached process GROUPS (n8n spawns task runners); kill(-pid) takes the whole tree
  const procs: ChildProcess[] = [
    spawn(process.execPath, ["bin/n8n"], { cwd: path.join(SRC, "packages/cli"), env, stdio: log("n8n"), detached: true }),
    // the session gateway (both variants — env symmetry; the baseline build never connects)
    spawn(process.execPath, [fileURLToPath(new URL("./gateway.mts", import.meta.url))], { env, stdio: log("gateway"), detached: true }),
  ];
  const close = (): void => procs.forEach((p) => { try { process.kill(-p.pid!, "SIGTERM"); } catch { p.kill(); } });
  process.on("exit", close);
  try {
    await waitForN8n(300_000);
    const t0 = Date.now();
    while (!(await serving(GATEWAY))) {
      if (Date.now() - t0 > 60_000) throw new Error("timeout waiting for " + GATEWAY);
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (err) {
    close();
    throw err;
  }
  return { close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bootN8n();
  console.log(`n8n (${VARIANT}) up: ${APP} — ctrl-c to stop`);
  await new Promise(() => {});
}
