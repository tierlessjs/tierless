// Diagnose the residual: capture the EDITOR route's boot GET paths (navigate to an actual
// /workflow/:id) and compare to the /home/workflows manifest. If the new GETs are route-
// GENERIC, expanding the static manifest closes the gap with no rebuild; if they are
// workflow-ID-SPECIFIC, only route-aware preboot can cover them.
//   node ports/n8n/capture-editor.mts
import { bootN8n, APP } from "./boot.mts";
import { existsSync, rmSync, readFileSync } from "node:fs";

const EDITOR_LOG = "/tmp/editor-gets.txt";
if (existsSync(EDITOR_LOG)) rmSync(EDITOR_LOG);
process.env.TIERLESS_LOG_GETS = EDITOR_LOG;
process.env.TIERLESS_HELLO_AUTH = "1";
process.env.TIERLESS_PREBOOT = "0";   // capture all crossings

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
  const id = "new";   // the editor boot (a fresh workflow) — captures the editor-generic fan-out
  const state = await rc.storageState();
  const browser = await chromium.launch({ headless: true, executablePath: SHELL });
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(APP + "/workflow/new", { waitUntil: "domcontentloaded" });
  try { await page.waitForLoadState("networkidle", { timeout: 20000 }); } catch { /* fine */ }
  await page.waitForTimeout(1500);
  await browser.close();
  await rc.dispose();

  await new Promise((r) => setTimeout(r, 500));
  const home = new Set(readFileSync("/home/user/tierless/ports/n8n/results/preboot-manifest.txt", "utf8").split("\n").filter(Boolean));
  const editor = existsSync(EDITOR_LOG) ? readFileSync(EDITOR_LOG, "utf8").split("\n").filter(Boolean) : [];
  const P = (s: string) => process.stdout.write(s + "\n");
  P("\n== editor (/workflow/:id) boot GETs: " + editor.length + " ==");
  const genericNew: string[] = [], idNew: string[] = [];
  for (const g of editor) {
    if (home.has(g)) continue;                          // already covered by the home manifest
    (g.includes(id) ? idNew : genericNew).push(g);
  }
  P("  already in home manifest (join today): " + editor.filter((g) => home.has(g)).length);
  P("  NEW route-generic (add to static manifest, no rebuild): " + genericNew.length);
  for (const g of genericNew) P("     " + g);
  P("  NEW workflow-ID-specific (need route-aware preboot): " + idNew.length);
  for (const g of idNew) P("     " + g.replace(id, ":id"));
} finally { boot.close(); }
