// Boot the fetched Grafana the way THEIR e2e lane does (playwright.config.ts
// webServer: `./e2e-playwright/start-server` — grafana binary, e2e ini, sqlite,
// admin/admin — on :3001), plus the session gateway on :3101 (page port + 100).
// Build first (ports/grafana/README.md): make build-go, yarn build,
// yarn e2e:plugin:build. Exports bootGrafana(); run directly to boot and hold.
//
//   node ports/grafana/boot.mts [--baseline]
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VARIANT = process.argv.includes("--baseline") ? "grafana-baseline" : "grafana";
const WORK = fileURLToPath(new URL(`../work/${VARIANT}/`, import.meta.url));
const SRC = path.join(WORK, "src/");
export const FRONT = "http://127.0.0.1:3001";     // grafana serves app AND api on one origin
export const GATEWAY = "http://127.0.0.1:3101";

const serving = (url: string): Promise<boolean> => fetch(url).then(() => true, () => false);
async function waitFor(url: string, ms: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + url);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function bootGrafana(): Promise<{ close(): void }> {
  if (!existsSync(path.join(SRC, "bin/grafana"))) throw new Error("backend not built — make build-go in " + SRC);
  if (!existsSync(path.join(SRC, "public/build"))) throw new Error("frontend not built — yarn build in " + SRC);
  for (const url of [FRONT, GATEWAY]) {
    if (await serving(url)) throw new Error(`${url} is already serving — a stale stack owns the port; kill it before booting`);
  }
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  const log = (name: string): ["ignore", number, number] => { const fd = openSync(path.join(WORK, name + ".log"), "w"); return ["ignore", fd, fd]; };
  const procs: ChildProcess[] = [
    // their script verbatim: e2e ini (sqlite, admin/admin, provisioned test plugins)
    spawn("bash", ["e2e-playwright/start-server"], { cwd: SRC, env, stdio: log("server"), detached: true }),
    // the session gateway, both variants (env symmetry; a baseline build never
    // connects). Grafana is a cookie-auth app (grafana_session, httpOnly), so the
    // gateway mediates cookie authority: the ws upgrade carries the cookie (cookies
    // scope to host, not port) and crossings replay it against the backend.
    spawn(process.execPath, [
      fileURLToPath(new URL("../../packages/tierless/bin/tierless.mjs", import.meta.url)), "gateway",
      "--backend", FRONT,
      "--port", "3101",
      "--cookie-authority",
      "--allow-origin", process.env.TIERLESS_ALLOWED_ORIGINS ||
        ["3001", "13001"].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(","),
    ], { env, stdio: log("gateway"), detached: true }),
  ];
  const close = (): void => procs.forEach((p) => { try { process.kill(-p.pid!, "SIGTERM"); } catch { p.kill(); } });
  process.on("exit", close);
  try {
    await Promise.all([
      waitFor(FRONT + "/api/health", 180_000),
      waitFor(GATEWAY, 60_000),
    ]);
  } catch (err) {
    close();
    throw err;
  }
  return { close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bootGrafana();
  console.log(`grafana up: ${FRONT}, gateway ${GATEWAY} — ctrl-c to stop`);
  await new Promise(() => { /* hold until killed */ });
}
