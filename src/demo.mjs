/* global document, window */
// Stackmix end-to-end: ONE continuation, compiled from a plain function (app/App.src.js,
// no hand-written state machine) by transform.cjs, flows across two real tiers over a
// real websocket:
//
//   server tier  — a `ws` host that owns api.* (the file-backed task DB). Render
//                  starts here.
//   browser tier — a real headless Chromium page (Playwright) that owns dom.*. It
//                  paints the vdom into real DOM and dispatches REAL click events;
//                  the resulting event token is the continuation's resume value.
//
// The continuation serializes to JSON (graph.mjs codec), crosses the socket via the
// wsPort/makePeer transport (transport.mjs), runs until it hits a resource the local tier
// doesn't own, and migrates to the owner. Render begins on the server and finishes in the
// browser the instant the vdom needs the real DOM — then bounces back to the server for the
// next api.* call. State lives in the continuation's frame locals, pinned to neither tier.
//
// Run:  node src/demo.mjs        (needs Playwright Chromium)
import { createRequire } from "node:module";
import { wsPort, makePeer } from "./transport.mjs";
import { pump, initialStack, encodeWire, decodeWire } from "./runtime.mjs";
import { vdomToHtml, shell } from "./dom.mjs";
import * as api from "./app/api.mjs";

const { chromium } = createRequire(process.env.PLAYWRIGHT_REQUIRE || "/opt/node22/lib/node_modules/")("playwright");
const { WebSocketServer, WebSocket } = createRequire(import.meta.url)("ws");
const trace = [];

// ---------------------------------------------------------------- server tier ----
const API = {
  "api.getTasks": (a) => api.getTasks(a), "api.getStats": () => api.getStats(),
  "api.addTask": (a) => api.addTask(a), "api.setStatus": (id, s) => api.setStatus(id, s), "api.deleteTask": (id) => api.deleteTask(id),
};
const ownsServer = (tier) => tier === "server";
const apiExec = (req) => { trace.push(`  server  ${req.name}(${JSON.stringify(req.args).slice(1, -1)})`); return API[req.name](...req.args); };

api.seed();
const wss = new WebSocketServer({ port: 0 });
await new Promise((r) => wss.on("listening", r));
const PORT = wss.address().port;

const serverDone = new Promise((resolve, reject) => {
  wss.on("connection", async (ws) => {
    const peer = makePeer(wsPort(ws));
    try {
      let res = await pump(initialStack("App"), ownsServer, apiExec);  // render starts here, runs to first dom.*
      while (!res.done) {
        trace.push(`  ── migrate → browser (${res.request.name})`);
        const { obj: reply } = await peer.request({ type: "resume", wire: encodeWire(res.stack, res.request) });
        if (reply.type === "error") throw new Error("browser: " + reply.message);
        if (reply.type === "done") { res = { done: true, value: reply.value }; break; }
        const { stack, request } = decodeWire(reply.wire);             // browser migrated it back at a server resource
        trace.push(`  ── migrate ← browser (${request.name})`);
        res = await pump(stack, ownsServer, apiExec, request);
      }
      resolve(res.value);
    } catch (e) { reject(e); }
  });
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

const ownsBrowser = (tier) => tier === "browser";
const ws = new WebSocket(`ws://localhost:${PORT}`);
const peer = makePeer(wsPort(ws));
peer.on("resume", async (req) => {                                       // server migrated the continuation here
  try {
    const { stack, request } = decodeWire(req.wire);
    const res = await pump(stack, ownsBrowser, domCommit, request);     // commit, read the click, run until a server resource
    if (res.done) return { obj: { type: "done", value: res.value } };
    return { obj: { type: "suspend", wire: encodeWire(res.stack, res.request) } };
  } catch (e) { return { obj: { type: "error", message: String((e && e.message) || e) } }; }
});
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });

// ----------------------------------------------------------------------- run ----
const value = await serverDone;
await browser.close();
wss.close();

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
