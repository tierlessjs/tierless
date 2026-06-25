import fs from "node:fs";
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
