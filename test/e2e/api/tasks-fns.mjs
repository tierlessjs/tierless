// The Tasks app's trusted service — the OTHER side of the boundary. The Tierless program
// (src/app/) is untrusted client code on every tier; this module is a separate application
// that happens to be co-developed in the same repo. It owns the backing store (the
// file-backed task DB) and exposes it ONLY through the reference monitor: the demos fork it
// as a sidecar (startSidecar) and hold nothing but a pipe client — they cannot import the
// DB, and the shortcut of calling it in-process is not expressible on the live path.
//
// Policy: reads are PUBLIC (an open dashboard), writes require an authenticated principal —
// and validate their args in authorize (per-call, per-args authority, same as server-fns).
// The demo server logs in as the demo user per connection and attaches the session token to
// every forwarded call; the monitor re-verifies it on each one.
//
// The pure functions are also exported directly: the single-process mechanics proofs
// (verify.mjs) drive them as an in-process resource host — the labeled degenerate mode for
// tests and trusted single-tenant deployments, not the default path (api-live.mjs proves
// the default path is the monitor).
import fs from "node:fs";
import { defineApi, PUBLIC } from "tierless/api";
import { sidecarMain } from "tierless/api";

// ---- the backing store (trusted state; lives with the service, not the client) ----------
const FILE = new URL("./tasks-db.json", import.meta.url);
const read = () => JSON.parse(fs.readFileSync(FILE, "utf8"));
const write = (d) => fs.writeFileSync(FILE, JSON.stringify(d));
const PRIO = { 3: "high", 2: "med", 1: "low" };
export function seed() {
  write({ nextId: 6, tasks: [
    { id: 1, title: "Fix login redirect", status: "doing", priority: 3, assignee: "ana" },
    { id: 2, title: "Upgrade Postgres",    status: "todo",  priority: 2, assignee: "bo" },
    { id: 3, title: "Write API docs",      status: "done",  priority: 1, assignee: "ana" },
    { id: 4, title: "Add rate limiting",   status: "todo",  priority: 3, assignee: "cy" },
    { id: 5, title: "Triage flaky test",   status: "doing", priority: 2, assignee: "bo" },
  ] });
}
export function getTasks({ status = "all" } = {}) {
  const { tasks } = read();
  let rows = status === "all" ? tasks : tasks.filter((t) => t.status === status);
  rows = rows.slice().sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title));
  return rows.map((t) => ({ ...t, prioLabel: PRIO[t.priority] }));
}
export function getStats() {
  const { tasks } = read(); const byStatus = { todo: 0, doing: 0, done: 0 }; const byAssignee = {};
  for (const t of tasks) { byStatus[t.status]++; byAssignee[t.assignee] = (byAssignee[t.assignee] || 0) + 1; }
  return { total: tasks.length, byStatus, pctDone: tasks.length ? Math.round(100 * byStatus.done / tasks.length) : 0, byAssignee };
}
export function addTask({ title, priority = 2, assignee = "new" }) {
  if (!title || !title.trim()) throw new Error("title required");
  const d = read(); const t = { id: d.nextId++, title: title.trim(), status: "todo", priority, assignee }; d.tasks.push(t); write(d); return t;
}
export function setStatus(id, status) { const d = read(); const t = d.tasks.find((x) => x.id === id); if (!t) throw new Error("no task " + id); t.status = status; write(d); return t; }
export function deleteTask(id) { const d = read(); d.tasks = d.tasks.filter((t) => t.id !== id); write(d); return { ok: true }; }

// ---- the monitor registration (who may call what, decided per call) ---------------------
const USERS = { demo: { pass: "demo", sub: "demo", role: "user" } };
const STATUSES = new Set(["todo", "doing", "done"]);

export const tasksApi = defineApi((api) => ({
  // PUBLIC login mints the session token INSIDE the trusted process (the secret never
  // crosses the pipe); the demo server calls it once per connection and carries the token.
  login: { authorize: PUBLIC, run: ([creds]) => {
    const u = creds && USERS[creds.user];
    if (!u || u.pass !== creds.pass) throw new Error("bad credentials");
    return api.issue({ sub: u.sub, role: u.role }, 3600);
  } },

  // Reads: an open dashboard — deliberately PUBLIC.
  getTasks: { authorize: PUBLIC, run: ([q]) => getTasks(q) },
  getStats: { authorize: PUBLIC, run: () => getStats() },

  // Writes: any authenticated principal, with the args validated per call — a forged
  // continuation (or a tokenless one) reaching these is denied HERE, whatever path it took.
  addTask: { authorize: (p) => p != null, run: ([t]) => addTask(t) },
  setStatus: { authorize: (p, [id, s]) => p != null && typeof id === "number" && STATUSES.has(s), run: ([id, s]) => setStatus(id, s) },
  deleteTask: { authorize: (p, [id]) => p != null && typeof id === "number", run: ([id]) => deleteTask(id) },
}), { maxArgsBytes: 8 * 1024, rate: { max: 300, windowMs: 10_000 } });

// Fork entry: does nothing on a normal import; forked by startSidecar it seeds the DB,
// mints the signing secret in-process, and serves the pipe.
sidecarMain(tasksApi, { init: seed });
