// BROWSER ENTRY for the LIVE React-tiers demo.
//
// This is the real browser tier — it runs IN a human's browser tab, not under
// Playwright script control. It:
//   1. opens a ws to the server (which owns api.* and starts the render),
//   2. answers "resume" by running pump() with ownsBrowser, so the continuation
//      finishes the render here and stops at dom.commit,
//   3. domCommit() paints the vdom into the REAL DOM under #root and then BLOCKS
//      on a real human click. A click resolves the commit promise with the node's
//      onClick event token, which becomes the continuation's resume value; pump
//      then migrates back to the server at the next api.* call.
//
// State (the `filter`, the task list) lives in the continuation's frame locals,
// pinned to neither tier — it just rides the socket back and forth.
//
// We import the transport SHIM (./transport.mjs), not /src/runtime/wss.mjs,
// because wss.mjs imports ./core.mjs (the full interpreter: Tier/Suspend/…) which
// is not needed in the browser and bloats/risks the module graph. runtime.mjs,
// however, is imported as-is from the served repo root: its relative imports
// (./app/bundle.gen.mjs and ../../src/runtime/heap.mjs) resolve over HTTP because
// the server uses the repo root as the web root.
import { wsPort, makePeer } from "./transport.mjs";
import { pump, encodeWire, decodeWire } from "/experiments/react-tiers/runtime.mjs";

const ownsBrowser = (tier) => tier === "browser";
const root = document.getElementById("root");
const statusEl = document.getElementById("status");
const setStatus = (s) => { if (statusEl) statusEl.textContent = s; };

// The single in-flight commit's resolver. domCommit() parks here; a real click
// (or the live event handlers we attach below) calls it with the event token.
let resolveClick = null;
function fireClick(token) {
  if (!resolveClick) return;            // no commit is currently waiting
  const r = resolveClick;
  resolveClick = null;
  r(token);
}

// Build a real DOM subtree from the serializable vdom: plain {type, props,
// children} nodes and string text. We set only data props (className/id/
// placeholder/value/type) and, for any node carrying an onClick event token,
// wire a REAL el.onclick that resolves the current commit with that token. The
// "add" button reads the live #add-title input value at click time and merges
// it into the token, exactly like the developer's App.src.js expects (ev.title).
function build(node) {
  if (node == null || node === false || node === true) return null;
  if (typeof node === "string" || typeof node === "number") {
    return document.createTextNode(String(node));
  }
  const { type, props = {}, children = [] } = node;
  const el = document.createElement(type);
  if (props.className != null) el.className = props.className;
  if (props.id != null) el.id = props.id;
  if (props.placeholder != null) el.placeholder = props.placeholder;
  if (props.type != null) el.type = props.type;
  if (props.value != null) el.value = props.value;
  if (props.onClick) {
    const token = props.onClick;
    el.onclick = () => {
      let tok = token;
      if (tok.ev === "add") {
        const inp = document.getElementById("add-title");
        tok = Object.assign({}, tok, { title: inp ? inp.value : "" });
      }
      fireClick(tok);
    };
  }
  for (const child of children) {
    const c = build(child);
    if (c) el.appendChild(c);
  }
  return el;
}

// dom.commit handler: paint, then WAIT for a real click. The returned promise is
// the continuation's resume value (the event token), so pump() suspends here
// until the human acts — that is the whole point of the live page.
function domCommit(req) {
  const vdom = req.args[0];
  const tree = build(vdom);
  root.replaceChildren(tree || document.createTextNode(""));
  setStatus("waiting for your click → the continuation is parked in the browser tier");
  return new Promise((res) => { resolveClick = res; });
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);
  const peer = makePeer(wsPort(ws));

  // The server migrated the continuation here. Finish the render locally, commit
  // to the real DOM, wait for the click, then either report done or hand the
  // continuation back to the server (suspend) at the next api.* resource.
  peer.on("resume", async (req) => {
    try {
      const { stack, request } = decodeWire(req.wire);
      const res = await pump(stack, ownsBrowser, domCommit, request);
      if (res.done) {
        setStatus("session ended: " + JSON.stringify(res.value));
        return { obj: { type: "done", value: res.value } };
      }
      setStatus("migrating ← server (" + res.request.name + ")");
      return { obj: { type: "suspend", wire: encodeWire(res.stack, res.request) } };
    } catch (e) {
      setStatus("client error: " + ((e && e.message) || e));
      return { obj: { type: "error", message: String((e && e.message) || e) } };
    }
  });

  ws.addEventListener("open", () => setStatus("connected — server is rendering…"));
  ws.addEventListener("close", () => setStatus("disconnected"));
  ws.addEventListener("error", () => setStatus("websocket error"));
}

connect();
