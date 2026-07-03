// Probe: create-tierless — scaffold a fresh app into a temp dir and RUN it end to end:
// build via the tierless bin, boot its server (which forks the api sidecar), connect as
// the browser tier, drive a real session — seeded render, an authorized add, a
// monitor-DENIED empty add landing in the app's try/catch across the tier, and a clean
// session end. The scaffold isn't just files; it's a working two-tier app.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "tierless/browser";
import { WS_PATH } from "tierless/server";
import { makeCounter } from "../lib/check.mts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "create-"));
const APP = join(dir, "my-notes");
const { check, counts } = makeCounter();

console.log("Probe: create-tierless — scaffold, build, boot, and drive a real session\n");

// ---- scaffold --------------------------------------------------------------------------
const c = spawnSync(process.execPath, [join(ROOT, "packages/create-tierless/index.mjs"), APP], { encoding: "utf8" });
check("the scaffolder runs and prints next steps", c.status === 0 && c.stdout.includes("npm run dev"), c.stderr);
check("the scaffold has the four app files + gitignore",
  ["app.src.js", "api.server.mjs", "server.mjs", "client.mjs", ".gitignore", "package.json"].every((f) => existsSync(join(APP, f))));
check("the app name is stamped", JSON.parse(readFileSync(join(APP, "package.json"), "utf8")).name === "my-notes");

// ---- "npm install" (a symlink stands in for the registry) + build ----------------------
mkdirSync(join(APP, "node_modules"), { recursive: true });
symlinkSync(join(ROOT, "packages/tierless"), join(APP, "node_modules", "tierless"), "dir");
const b = spawnSync(process.execPath, [join(ROOT, "packages/tierless/bin/tierless.mjs"), "build", "app.src.js", "app.gen.mjs", "--bare"], { cwd: APP, encoding: "utf8" });
check("the template app builds with the tierless bin", b.status === 0 && existsSync(join(APP, "app.gen.mjs")), b.stderr);

// ---- boot the scaffolded server (it forks the api sidecar) ------------------------------
const server = spawn(process.execPath, ["server.mjs"], { cwd: APP, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => { log += d; });
server.stderr.on("data", (d) => { log += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("server didn't start:\n" + log)), 15000);
  const iv = setInterval(() => { const m = log.match(/listening on http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); clearInterval(iv); res(Number(m[1])); } }, 100);
});
check("the scaffolded server boots and prints its URL", port > 0, port);

// ---- drive a session as the browser tier ------------------------------------------------
try {
  const bundle = await import(pathToFileURL(join(APP, "app.gen.mjs")).href);
  const commits = [];
  const script = [{ ev: "add", text: "hi from the probe" }, { ev: "add", text: "   " }, { ev: "stop" }];
  let si = 0;
  const conn = connect({ url: `ws://localhost:${port}${WS_PATH}`, bundle, exec: (req) => { commits.push(req.args[0]); return script[si++] || { ev: "stop" }; } });
  await conn.ready;
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("session didn't finish; commits=" + commits.length)), 15000);
    const iv = setInterval(() => { if (si >= script.length) { clearTimeout(t); clearInterval(iv); setTimeout(res, 300); } }, 100);
  });
  check("the seeded render crossed to the browser tier", commits[0] && commits[0].notes.length === 2, commits[0] && commits[0].notes);
  check("an authorized add went through the monitor with the principal attached",
    commits[1] && commits[1].notes.length === 3 && commits[1].notes[2].includes("hi from the probe — demo"), commits[1] && commits[1].notes[2]);
  check("a blank add was DENIED at the monitor and caught by the app's try/catch across the tier",
    commits[2] && commits[2].status.includes("rejected") && commits[2].status.includes("denied") && commits[2].notes.length === 3, commits[2] && commits[2].status);
  conn.close();
} finally {
  server.kill("SIGTERM");
}

const { pass, fail } = counts();
const ok = fail === 0;
console.log(ok
  ? `\nOK — create-tierless scaffolds a WORKING two-tier app: build, boot (api sidecar forked), seeded render, authorized write, monitor denial caught across the tier, clean end (${pass} checks)`
  : `\nFAILED (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
