function App() {
  let filter = "all";
  while (true) {
    const tasks = api.getTasks({ status: filter });
    const stats = api.getStats();
    const vdom = render(h(Dashboard, { tasks, stats, filter }));
    const ev = commit(vdom);
    if (ev.ev === "filter") filter = ev.value;
    else if (ev.ev === "add") api.addTask({ title: ev.title });
    else if (ev.ev === "cycle") api.setStatus(ev.id, ev.next);
    else if (ev.ev === "delete") api.deleteTask(ev.id);
    else break;
  }
  return "session ended";
}
