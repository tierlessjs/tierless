// BROWSER ENTRY for the LIVE demo — the real browser tier, in a human's tab.
//
// The whole host is one connect() call: it dials the session endpoint, registers this
// app's compiled bundle, and answers migrations. The server starts the render; the
// continuation finishes it here, and our `exec` services dom.commit — paint the vdom
// into the REAL DOM, then park until a real human click resolves the commit with its
// event token. State (the filter, the task list) lives in the continuation's frame
// locals, pinned to neither tier — it just rides the socket back and forth.
//
// Imports resolve over HTTP because the server serves the repo root as the web root.
import { connect } from "/src/browser.mjs";
import * as bundle from "/src/app/bundle.gen.mjs";

const root = document.getElementById("root");
const statusEl = document.getElementById("status");
const setStatus = (s) => { if (statusEl) statusEl.textContent = s; };

// The single in-flight commit's resolver. domCommit() parks here; a real click calls it
// with the clicked node's event token, which becomes the continuation's resume value.
let resolveClick = null;
function fireClick(token) {
  if (!resolveClick) return;            // no commit is currently waiting
  const r = resolveClick;
  resolveClick = null;
  r(token);
}

// Build a real DOM subtree from the serializable vdom: plain {type, props, children}
// nodes and string text. Any node carrying an onClick event token gets a REAL el.onclick
// that resolves the current commit with that token. The "add" button reads the live
// #add-title input value at click time, exactly like the developer's App.src.js expects.
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

// dom.commit: paint, then WAIT for a real click — the continuation is parked here.
function domCommit(req) {
  root.replaceChildren(build(req.args[0]) || document.createTextNode(""));
  setStatus("waiting for your click → the continuation is parked in the browser tier");
  return new Promise((res) => { resolveClick = res; });
}

const conn = connect({ bundle, exec: domCommit });
conn.ready.then(
  () => setStatus("connected — server is rendering…"),
  (e) => setStatus(String((e && e.message) || e)),
);
