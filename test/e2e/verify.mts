// Headless regression for the AUTO-GENERATED continuation (app/bundle.gen.mjs, emitted
// by transform.cjs from the hand-written-free app/App.src.js). No browser, no socket —
// it drives the compiled state machine in one process, servicing api.* against the tasks
// functions IN-PROCESS and feeding scripted events at each dom.commit, and asserts the
// app's behavior. In-process resource hosting is the labeled DEGENERATE mode — right for
// a single-process mechanics proof (fast, deterministic), never the default path: the
// default path services api.* through the reference monitor in its own process, which
// api-live.mjs proves on this same app. demo.mjs proves the same continuation also
// migrates across a real websocket into real Chromium.
import { run, start } from "./app/bundle.gen.mjs";
import * as api from "./api/tasks-fns.mts";
import { textOf } from "./app/render.mts";
import type { Rendered } from "./app/render.mts";

api.seed();
const API: Record<string, (...args: unknown[]) => unknown> = {
  "api.getTasks": (a) => api.getTasks(a as { status?: string } | undefined), "api.getStats": () => api.getStats(),
  "api.addTask": (a) => api.addTask(a as { title: string }), "api.setStatus": (id, s) => api.setStatus(id as number, s as string), "api.deleteTask": (id) => api.deleteTask(id as number),
};
const events = [
  { ev: "filter", value: "done" }, { ev: "filter", value: "all" },
  { ev: "cycle", id: 2, next: "doing" }, { ev: "add", title: "Ship the demo" },
  { ev: "delete", id: 1 }, { ev: "stop" },
];
let ei = 0;
const commits: string[] = [];
let res = start("App");
while (!res.done) {
  const req = res.request;
  if (req.tier === "browser" && req.name === "dom.commit") {
    commits.push(textOf(req.args[0] as Rendered));
    res.stack[res.stack.length - 1].ret = events[ei++] || { ev: "stop" };
  } else if (req.tier === "server") {
    res.stack[res.stack.length - 1].ret = API[req.name](...req.args);
  } else {
    throw new Error("unknown request " + JSON.stringify(req));
  }
  res = run(res.stack);
}

commits.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
const ok = res.value === "session ended" && commits.length === 6 &&
  commits[0].includes("todo 2 / doing 2 / done 1") &&
  commits[1].includes("Write API docs") && !commits[1].includes("Fix login redirect") &&
  commits[3].includes("todo 1 / doing 3 / done 1") &&
  commits[4].includes("6 tasks") && commits[4].includes("Ship the demo") &&
  commits[5].includes("5 tasks");
console.log("\n=> " + res.value);
console.log(ok
  ? "PASS — auto-compiled tier-split continuation produced the correct session"
  : "FAIL\n" + commits.join(" | "));
process.exit(ok ? 0 : 1);
