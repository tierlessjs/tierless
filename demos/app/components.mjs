// Plain presentational components. They emit serializable onClick EVENT TOKENS
// (e.g. {ev:"cycle", id, next}) instead of closures, because the rendered vdom is
// shipped across the wire to the browser tier and a click there resolves the
// continuation with that exact token.
import { h } from "./h.mjs";

export const nextStatus = (s) => (s === "todo" ? "doing" : s === "doing" ? "done" : "todo");

export function StatsBar({ stats }) {
  return h("div", { className: "stats" }, h("strong", null, stats.total + " tasks"),
    h("span", null, " · " + stats.pctDone + "% done · todo " + stats.byStatus.todo + " / doing " + stats.byStatus.doing + " / done " + stats.byStatus.done));
}
export function FilterBar({ filter }) {
  return h("div", { className: "filters" }, ["all", "todo", "doing", "done"].map((f) =>
    h("button", { key: f, className: f === filter ? "active" : "", onClick: { ev: "filter", value: f } }, f)));
}
export function TaskRow({ task }) {
  return h("li", { className: "task " + task.status },
    h("span", { className: "badge" }, task.status), h("span", { className: "prio" }, task.prioLabel),
    h("span", { className: "title" }, task.title), h("span", { className: "who" }, "@" + task.assignee),
    h("button", { onClick: { ev: "cycle", id: task.id, next: nextStatus(task.status) } }, "cycle"),
    h("button", { onClick: { ev: "delete", id: task.id } }, "x"));
}
export function TaskList({ tasks }) { return h("ul", { className: "tasks" }, tasks.map((t) => h(TaskRow, { key: t.id, task: t }))); }
export function Dashboard({ tasks, stats, filter }) {
  return h("div", { className: "dashboard" }, h("h1", null, "Tasks"), h(StatsBar, { stats }),
    h(FilterBar, { filter }), h(TaskList, { tasks }),
    h("div", { className: "addbar" }, h("input", { id: "add-title", placeholder: "New task title" }),
      h("button", { className: "add", onClick: { ev: "add" } }, "+ add")));
}
