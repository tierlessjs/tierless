/* global document */
// Headless check for the LIVE page (server-live.mts + public/client.mjs). Starts the
// server, opens the served page in real Chromium (Playwright), and performs REAL clicks
// on the rendered buttons — firing the CLIENT's own el.onclick handlers (no injected
// bridge) — asserting the real DOM updates correctly each time. This needs Playwright,
// so it is run on demand (not part of `npm test`); the Chromium-free verify.mjs and
// control-flow.mjs guard the logic in CI.
//
// Run:  node test/e2e/verify-live.mts
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// playwright: loaded via createRequire (no @types/playwright wired into this tsconfig) — chromium, browser, page are all any
const { chromium } = createRequire(process.env.PLAYWRIGHT_REQUIRE || "/opt/node22/lib/node_modules/")("playwright");
const SERVER = fileURLToPath(new URL("./server-live.mts", import.meta.url));
const PORT = Number(process.env.PORT) || 8231;
const URL_ = `http://localhost:${PORT}/`;

const fails: string[] = [];
const assert = (cond: boolean, msg: string): void => { if (!cond) fails.push(msg); else console.log("  ok:", msg); };
const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
const waitFor = (pred: () => boolean, ms: number, label: string): Promise<void> => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (pred()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error("timeout: " + label)); } }, 50);
});

// {text, scope} identifies a rendered <button> the same way in both the wait-poll and the
// real click below: scope narrows to the enclosing li.task (by its rendered text) first.
type ClickTarget = { text: string; scope?: string };
const clickButton = async (page: any, text: string, scope?: string): Promise<void> => {
  await page.waitForFunction(({ text, scope }: ClickTarget) => {       // wait for the target to be present (each click re-renders async)
    const root = scope ? [...document.querySelectorAll<HTMLElement>("li.task")].find((r) => r.innerText.includes(scope)) : document;
    return root && [...root.querySelectorAll("button")].some((x) => x.textContent!.trim() === text);
  }, { text, scope }, { timeout: 8000 });
  await page.evaluate(({ text, scope }: ClickTarget) => {
    const root = scope ? [...document.querySelectorAll<HTMLElement>("li.task")].find((r) => r.innerText.includes(scope)) : document;
    [...root!.querySelectorAll("button")].find((x) => x.textContent!.trim() === text)!.click();
  }, { text, scope });
};
const rootText = (page: any) => page.evaluate(() => document.getElementById("root")!.innerText.replace(/\s+/g, " ").trim());

let browser: any;
try {
  await waitFor(() => log.includes(`http://localhost:${PORT}`), 8000, "server listening");
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(String((e && e.stack) || e)));
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const r = document.getElementById("root"); return r && /Tasks/.test(r.innerText) && r.querySelector("button"); }, { timeout: 8000 });

  const initial = await rootText(page);
  assert(/5 tasks/.test(initial) && /todo 2 \/ doing 2 \/ done 1/.test(initial), "initial render: 5 tasks, todo 2 / doing 2 / done 1");

  await clickButton(page, "done");                                       // filter = done
  await page.waitForFunction(() => { const x = document.getElementById("root")!.innerText; return /Write API docs/.test(x) && !/Fix login redirect/.test(x); }, { timeout: 8000 });
  assert(true, "real click 'done' filter → only the done task remains");

  await clickButton(page, "all");                                        // back to all
  await page.waitForFunction(() => /Add rate limiting/.test(document.getElementById("root")!.innerText), { timeout: 8000 }); // a todo row, hidden in the done filter — unambiguous

  await clickButton(page, "cycle", "Upgrade Postgres");                  // cycle id 2 todo->doing
  await page.waitForFunction(() => /todo 1 \/ doing 3 \/ done 1/.test(document.getElementById("root")!.innerText), { timeout: 8000 });
  assert(true, "real click 'cycle' → stats recompute to todo 1 / doing 3 / done 1");

  await page.fill("#add-title", "Ship the live page");                   // type into the real input + add
  await clickButton(page, "+ add");
  await page.waitForFunction(() => /6 tasks/.test(document.getElementById("root")!.innerText), { timeout: 8000 });
  const afterAdd = await rootText(page);
  assert(/6 tasks/.test(afterAdd) && /Ship the live page/.test(afterAdd), "real typed input + '+ add' → 6 tasks incl. 'Ship the live page'");

  await clickButton(page, "x", "Fix login redirect");                    // delete
  await page.waitForFunction(() => { const x = document.getElementById("root")!.innerText; return /5 tasks/.test(x) && !/Fix login redirect/.test(x); }, { timeout: 8000 });
  assert(true, "real click 'x' → back to 5 tasks, deleted row gone");

  assert(pageErrors.length === 0, "no client-side pageerror events" + (pageErrors.length ? ": " + pageErrors.join(" | ") : ""));
} catch (e: any) {
  fails.push("EXCEPTION: " + ((e && e.stack) || e));
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill("SIGTERM");
}

if (fails.length === 0) {
  console.log("\nPASS — live human-clickable browser tier: real clicks drove the continuation across a real websocket and updated the real DOM.");
  process.exit(0);
}
console.log("\nFAIL"); fails.forEach((f) => console.log("  - " + f)); process.exit(1);
