// Capture the preboot manifest: boot the ported app with the gateway logging every distinct
// 2xx GET path it serves, drive ONE authenticated boot, and the gateway writes the boot GET
// paths to results/preboot-manifest.txt (frozen input for the preboot arm, run-protocol
// style). Run once; inspect the file; freeze it.
//   node ports/n8n/capture-manifest.mts
import { bootN8n, APP } from "./boot.mts";
import { existsSync, rmSync, readFileSync } from "node:fs";

const MANIFEST = "/home/user/tierless/ports/n8n/results/preboot-manifest.txt";
if (existsSync(MANIFEST)) rmSync(MANIFEST);
process.env.TIERLESS_LOG_GETS = MANIFEST;
process.env.TIERLESS_HELLO_AUTH = "1";
process.env.TIERLESS_PREBOOT = "0";   // no preboot while capturing (all GETs must cross to be logged)

const PW = "/home/user/tierless/ports/work/n8n/src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.js";
const pw = (await import(PW)).default;
const { chromium, request } = pw;
const SHELL = "/root/pw-browsers/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";
const OWNER = { email: "nathan@n8n.io", password: "PlaywrightTest123", firstName: "N", lastName: "R", mfaEnabled: false };

const boot = await bootN8n();
try {
  const rc = await request.newContext({ baseURL: APP });
  await rc.post("/rest/e2e/reset", { data: { owner: OWNER, members: [], admin: { email: "admin@n8n.io", password: "PlaywrightTest123", firstName: "A", lastName: "D" }, chat: { email: "chat@n8n.io", password: "PlaywrightTest123" } } });
  await new Promise((r) => setTimeout(r, 800));
  await rc.post("/rest/login", { data: { emailOrLdapLoginId: OWNER.email, password: OWNER.password } });
  const state = await rc.storageState();
  const browser = await chromium.launch({ headless: true, executablePath: SHELL });
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(APP + "/home/workflows", { waitUntil: "domcontentloaded" });
  try { await page.waitForLoadState("networkidle", { timeout: 20000 }); } catch { /* fine */ }
  await page.waitForTimeout(1500);
  await browser.close();
  await rc.dispose();
} finally { boot.close(); }

await new Promise((r) => setTimeout(r, 500));
if (existsSync(MANIFEST)) {
  const paths = readFileSync(MANIFEST, "utf8").split("\n").filter(Boolean);
  process.stdout.write("\ncaptured " + paths.length + " boot GET paths -> " + MANIFEST + "\n");
  for (const p of paths) process.stdout.write("  " + p + "\n");
} else process.stdout.write("\nNO manifest written — check the gateway LOG_GETS wiring\n");
