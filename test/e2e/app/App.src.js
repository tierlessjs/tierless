// loadView fetches the data and renders. It calls api.* so it is suspendable; App
// calls it, so the continuation spans the call boundary — when loadView suspends on a
// resource, the stack is [App, loadView] and migrates as a unit. (api.* runs on the
// server, so loadView resolves there before the vdom migrates to the browser to commit;
// the cross-tier multi-frame case is exercised headlessly in control-flow.mjs.)
function loadView(filter) {
  const tasks = api.getTasks({ status: filter });
  const stats = api.getStats();
  return render(h(Dashboard, { tasks, stats, filter }));
}

function App() {
  let filter = "all";
  while (true) {
    const vdom = loadView(filter);          // nested suspendable call: push a sub-frame
    const ev = commit(vdom);
    if (ev.ev === "filter") filter = ev.value;
    else if (ev.ev === "add") api.addTask({ title: ev.title });
    else if (ev.ev === "cycle") api.setStatus(ev.id, ev.next);
    else if (ev.ev === "delete") api.deleteTask(ev.id);
    else break;
  }
  return "session ended";
}
