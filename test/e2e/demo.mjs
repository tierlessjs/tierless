/* global document, window */
// Tierless end-to-end: ONE continuation, compiled from a plain function (app/App.src.js,
// no hand-written state machine) by transform.cjs, flows across two real tiers over a
// real websocket:
//
//   server tier  — serveApp() hosting the session endpoint, with every api.* serviced by
//                  the tasks service (a reference-monitor sidecar in its own process; the
//                  default api.* path). Render starts here.
//   browser tier — a real headless Chromium page (Playwright) that owns dom.*. It paints
//                  the vdom into real DOM and dispatches REAL click events; the resulting
//                  event token is the continuation's resume value. connect() answers the
//                  migrations; this Node process just adapts dom.commit onto the page.
//
// Run:  node src/demo.mjs        (needs Playwright Chromium)
import { createRequire } from "node:module";
import { serveApp } from "tierless/server";
import { connect } from "tierless/browser";
import { startSidecar, makeApiExec } from "tierless/api";
import { vdomToHtml, shell } from "./dom.mts";
import * as bundle from "./app/bundle.gen.mjs";
import { WS_PATH } from "tierless/server";

const { chromium } = createRequire(process.env.PLAYWRIGHT_REQUIRE || "/opt/node22/lib/node_modules/")("playwright");
const trace = [];

// ---------------------------------------------------------------- server tier ----
const apiService = startSidecar(new URL("./api/tasks-fns.mts", import.meta.url));
await apiService.ready();

let resolveSession;
const sessionDone = new Promise((r) => { resolveSession = r; });
const app = await serveApp({
  port: 0,
  bundle,
  session: async () => {
    const login = await apiService.call("login", [{ user: "demo", pass: "demo" }]);
    if (!login.ok) throw new Error("login failed: " + login.error);
    const exec = makeApiExec(apiService, login.value);
    return {
      exec: (req) => { trace.push(`  server  ${req.name}(${JSON.stringify(req.args).slice(1, -1)}) → monitor`); return exec(req); },
      entry: "App",
      onDone: resolveSession,
    };
  },
});

// --------------------------------------------------------------- browser tier ----
const browser = await chromium.launch();
const page = await browser.newPage();

// __smClick is the page->Node bridge for a real click; it persists across the
// per-commit setContent navigations. The click delegation itself is (re)attached
// after each setContent (addInitScript does NOT re-run on setContent).
let pendingClick = null;
await page.exposeBinding("__smClick", (_src, tok) => { const r = pendingClick; pendingClick = null; if (r) r(tok); });
const attachClickDelegation = () => page.evaluate(() => {
  document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest("[data-ev]");
    if (!el) return;
    let tok = JSON.parse(el.getAttribute("data-ev"));
    if (tok.ev === "add") { const inp = document.getElementById("add-title"); tok = Object.assign({}, tok, { title: inp ? inp.value : "" }); }
    window.__smClick(tok);
  });
});

// The scripted "user". Each entry drives ONE real interaction in Chromium per commit.
const SCRIPT = [
  { ev: "filter", value: "done" }, { ev: "filter", value: "all" },
  { ev: "cycle", id: 2 }, { ev: "add", title: "Ship the demo" },
  { ev: "delete", id: 1 }, { ev: "stop" },
];
let si = 0;
const commits = [];

async function domCommit(req) {                                          // req = { name:"dom.commit", args:[vdom] }
  await page.setContent(shell(vdomToHtml(req.args[0])));                  // paint real DOM in Chromium
  await attachClickDelegation();                                         // re-wire click->token bridge for this document
  const text = await page.evaluate(() => document.getElementById("root").innerText.replace(/\s+/g, " ").trim());
  commits.push(text);
  trace.push(`  browser dom.commit  «${text.slice(0, 60)}…»`);
  const action = SCRIPT[si++] || { ev: "stop" };
  if (action.ev === "stop") return { ev: "stop" };                       // user closes the tab
  return await new Promise((resolve, reject) => {                        // wait for the REAL click token
    pendingClick = resolve;
    (async () => {
      if (action.ev === "add") await page.fill("#add-title", action.title);
      const matched = await page.evaluate((want) => {                   // tag the element matching the scripted intent
        document.querySelectorAll("[data-click-target]").forEach((e) => e.removeAttribute("data-click-target"));
        const all = [...document.querySelectorAll("[data-ev]")];
        const el = all.find((e) => {
          const tk = JSON.parse(e.getAttribute("data-ev"));
          return tk.ev === want.ev && (want.id == null || tk.id === want.id) && (want.value == null || tk.value === want.value);
        });
        if (el) { el.setAttribute("data-click-target", "1"); return true; }
        return { available: all.map((e) => e.getAttribute("data-ev")) };
      }, action);
      if (matched !== true) throw new Error(`no element for ${JSON.stringify(action)}; available ${JSON.stringify(matched.available)}`);
      await page.click("[data-click-target='1']", { timeout: 5000 });   // a real Chromium click event
    })().catch(reject);
  });
}

const conn = connect({ url: `ws://localhost:${app.port}${WS_PATH}`, bundle, exec: domCommit });
await conn.ready;

// ----------------------------------------------------------------------- run ----
const value = await sessionDone;
await browser.close();
conn.close();
app.close();
apiService.close();

console.log("migration trace (one continuation, two tiers, real socket + real Chromium):\n");
console.log(trace.join("\n"));
console.log("\nDOM commits the real Chromium page painted:\n");
commits.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));

const ok = value === "session ended" && commits.length === 6 &&
  commits[1].includes("Write API docs") && !commits[1].includes("Fix login redirect") &&  // filter=done isolates the done task
  commits[3].includes("todo 1 / doing 3 / done 1") &&                                      // cycle id2 todo->doing
  commits[4].includes("6 tasks") && commits[4].includes("Ship the demo") &&                // add (typed into the real input)
  commits[5].includes("5 tasks");                                                          // delete id1
console.log(`\n=> ${value}`);
console.log(ok
  ? "\nPASS — auto-compiled continuation migrated across a real websocket and a real Chromium DOM."
  : "\nFAIL\n" + commits.join(" | "));
process.exit(ok ? 0 : 1);
