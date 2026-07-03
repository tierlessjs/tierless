// Plain presentational components. They emit serializable onClick EVENT TOKENS
// (e.g. {ev:"cycle", id, next}) instead of closures, because the rendered vdom is
// shipped across the wire to the browser tier and a click there resolves the
// continuation with that exact token.
import { h } from "./h.mts";

interface Task { id: string | number; status: string; prioLabel: string; title: string; assignee: string }
interface Stats { total: number; pctDone: number; byStatus: { todo: number; doing: number; done: number } }

export const nextStatus = (s: string): string => (s === "todo" ? "doing" : s === "doing" ? "done" : "todo");

export function StatsBar({ stats }: { stats: Stats }) {
  return h("div", { className: "stats" }, h("strong", null, stats.total + " tasks"),
    h("span", null, " · " + stats.pctDone + "% done · todo " + stats.byStatus.todo + " / doing " + stats.byStatus.doing + " / done " + stats.byStatus.done));
}
export function FilterBar({ filter }: { filter: string }) {
  return h("div", { className: "filters" }, ["all", "todo", "doing", "done"].map((f) =>
    h("button", { key: f, className: f === filter ? "active" : "", onClick: { ev: "filter", value: f } }, f)));
}
export function TaskRow({ task }: { task: Task }) {
  return h("li", { className: "task " + task.status },
    h("span", { className: "badge" }, task.status), h("span", { className: "prio" }, task.prioLabel),
    h("span", { className: "title" }, task.title), h("span", { className: "who" }, "@" + task.assignee),
    h("button", { onClick: { ev: "cycle", id: task.id, next: nextStatus(task.status) } }, "cycle"),
    h("button", { onClick: { ev: "delete", id: task.id } }, "x"));
}
export function TaskList({ tasks }: { tasks: Task[] }) { return h("ul", { className: "tasks" }, tasks.map((t) => h(TaskRow, { key: t.id, task: t }))); }
export function Dashboard({ tasks, stats, filter }: { tasks: Task[]; stats: Stats; filter: string }) {
  return h("div", { className: "dashboard" }, h("h1", null, "Tasks"), h(StatsBar, { stats }),
    h(FilterBar, { filter }), h(TaskList, { tasks }),
    h("div", { className: "addbar" }, h("input", { id: "add-title", placeholder: "New task title" }),
      h("button", { className: "add", onClick: { ev: "add" } }, "+ add")));
}
