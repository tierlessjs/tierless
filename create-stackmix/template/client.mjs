// The browser tier — one connect() call. The server starts the App session; the
// continuation finishes each render here, and this exec services commit(): paint the
// payload into the real DOM, then park until the user acts. The resolved event token is
// the continuation's resume value.
//
// Imports resolve over HTTP: the server serves this app directory (node_modules included)
// as the web root — a dev-mode convenience; bundle for production.
import { connect } from "/node_modules/stackmix/src/browser.mjs";
import * as bundle from "/app.gen.mjs";

const root = document.getElementById("root");
const statusEl = document.getElementById("status");

let resolveEvent = null;
function commitExec(req) {
  const { notes, status } = req.args[0];
  root.replaceChildren();
  const ul = document.createElement("ul");
  for (const n of notes) { const li = document.createElement("li"); li.textContent = n; ul.appendChild(li); }
  const bar = document.createElement("div"); bar.className = "addbar";
  const input = document.createElement("input"); input.placeholder = "add a note (empty → the monitor rejects it)";
  const btn = document.createElement("button"); btn.textContent = "add";
  const fire = () => { const r = resolveEvent; resolveEvent = null; if (r) r({ ev: "add", text: input.value }); };
  btn.onclick = fire;
  input.onkeydown = (e) => { if (e.key === "Enter") fire(); };
  bar.append(input, btn);
  root.append(ul, bar);
  statusEl.textContent = status || "parked in your browser — the continuation resumes on add";
  input.focus();
  return new Promise((res) => { resolveEvent = res; });
}

const conn = connect({ bundle, exec: commitExec });
conn.ready.then(
  () => { statusEl.textContent = "connected — server is rendering…"; },
  (e) => { statusEl.textContent = String((e && e.message) || e); },
);
