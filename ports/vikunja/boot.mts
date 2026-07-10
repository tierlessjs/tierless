// Boot the fetched Vikunja (backend binary + vite preview) the way THEIR CI does
// (.github/workflows/test.yml, job test-frontend-e2e-playwright): SQLite in-memory,
// the testing seed API enabled by VIKUNJA_SERVICE_TESTINGTOKEN, CORS on, frontend on
// :4173, API on :3456. Exports bootVikunja() for journeys; run directly to boot and hold.
//
//   node ports/vikunja/boot.mts [--baseline]     (build first: see README.md)
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VARIANT = process.argv.includes("--baseline") ? "vikunja-baseline" : "vikunja";
const SRC = fileURLToPath(new URL(`../work/${VARIANT}/src/`, import.meta.url));
export const API = "http://127.0.0.1:3456";
export const FRONT = "http://127.0.0.1:4173";
export const TESTING_TOKEN = "averyLongSecretToSe33dtheDB";   // their CI's value — the seed API only exists when set

const ENV = {
  ...process.env,
  VIKUNJA_SERVICE_TESTINGTOKEN: TESTING_TOKEN,
  VIKUNJA_LOG_LEVEL: "ERROR",
  VIKUNJA_CORS_ENABLE: "1",
  VIKUNJA_SERVICE_PUBLICURL: API,
  VIKUNJA_DATABASE_PATH: "memory",
  VIKUNJA_DATABASE_TYPE: "sqlite",
  VIKUNJA_RATELIMIT_NOAUTHLIMIT: "1000",
};

async function waitFor(url: string, ms = 60_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + url);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function bootVikunja(): Promise<{ close(): void }> {
  if (!existsSync(path.join(SRC, "vikunja"))) throw new Error("backend not built — see ports/vikunja/README.md");
  if (!existsSync(path.join(SRC, "frontend/dist/index.html"))) throw new Error("frontend not built — see ports/vikunja/README.md");
  // refuse ports that are already up: waitFor() would otherwise "succeed" against a
  // stale stack from an earlier run and every measurement would silently test old code
  for (const url of [API + "/api/v1/info", FRONT]) {
    const alive = await fetch(url).then((r) => r.ok, () => false);
    if (alive) throw new Error(`${url} is already serving — a stale stack owns the port; kill it before booting`);
  }
  // detached process GROUPS: pnpm/vite spawn children of their own, and killing only the
  // wrapper leaves a stale preview owning the port while the next boot binds elsewhere —
  // every probe then talks to old code. kill(-pid) takes the whole group down.
  const procs: ChildProcess[] = [
    spawn(path.join(SRC, "vikunja"), [], { cwd: SRC, env: ENV, stdio: "ignore", detached: true }),
    spawn("corepack", ["pnpm", "run", "preview"], { cwd: path.join(SRC, "frontend"), env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" }, stdio: "ignore", detached: true }),
  ];
  // cleanup exists BEFORE any await: a failed readiness wait must not strand the
  // detached groups — that would create exactly the stale stack the guard above rejects
  const close = (): void => procs.forEach((p) => { try { process.kill(-p.pid!, "SIGTERM"); } catch { p.kill(); } });
  process.on("exit", close);
  try {
    await Promise.all([waitFor(API + "/api/v1/info"), waitFor(FRONT)]);
  } catch (err) {
    close();
    throw err;
  }
  return { close };
}

// ---- their seed + login mechanics (tests/support/factory.ts, authenticateUser.ts) -------
const TEST_PASSWORD = "1234";
const TEST_PASSWORD_HASH = "$2a$14$dcadBoMBL9jQoOcZK8Fju.cy0Ptx2oZECkKLnaa8ekRoTFe1w7To.";

export async function seed(table: string, rows: Record<string, unknown>[], truncate = true): Promise<void> {
  const r = await fetch(`${API}/api/v1/test/${table}?truncate=${truncate}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: TESTING_TOKEN },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`seed ${table}: ${r.status} ${await r.text()}`);
}

/** One user, one project with the four default views, n tasks — the shape their
 *  project-view specs build (tests/e2e/project/prepareProjects.ts). Returns the login token. */
export async function seedProjectWithTasks(nTasks: number): Promise<string> {
  const now = new Date().toISOString();
  await seed("users", [{ id: 1, username: "demo", password: TEST_PASSWORD_HASH, status: 0, issuer: "local", language: "en", created: now, updated: now }]);
  await seed("projects", [{ id: 1, title: "First Project", owner_id: 1, created: now, updated: now }]);
  const VIEW_TITLES = ["List", "Gantt", "Table", "Kanban"];
  await seed("project_views", [0, 1, 2, 3].map((kind, i) => ({ id: i + 1, title: VIEW_TITLES[i], project_id: 1, view_kind: kind, created: now, updated: now, ...(kind === 3 ? { bucket_configuration_mode: 1 } : {}) })));
  await seed("tasks", Array.from({ length: nTasks }, (_, i) => ({ id: i + 1, title: `Task number ${i + 1}`, done: false, project_id: 1, created_by_id: 1, index: i + 1, created: now, updated: now })));
  const login = await fetch(`${API}/api/v1/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "demo", password: TEST_PASSWORD }),
  });
  if (!login.ok) throw new Error(`login: ${login.status} ${await login.text()}`);
  return (await login.json() as { token: string }).token;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await bootVikunja();
  console.log(`vikunja up: ${FRONT} (frontend) / ${API} (api) — ctrl-c to stop`);
  process.on("SIGINT", () => { app.close(); process.exit(0); });
}
