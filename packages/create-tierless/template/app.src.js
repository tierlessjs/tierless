// Your app — ONE plain function that runs across both tiers. `api.*` is the server
// resource (serviced by the reference-monitor sidecar); `commit()` is the browser
// resource (paint + wait for the user). Tierless compiles this into a serializable
// state machine and migrates it between tiers at those calls — the `while` loop and
// its locals live in the continuation, pinned to neither side.
//
// Rebuild after editing: npm run build   (or: npm run dev to build + serve)
// See what compiles:     npm run explain
function App() {
  let status = "";
  while (true) {
    const notes = api.list();
    const ev = commit({ notes, status });
    if (ev.ev === "add") {
      try {
        api.add(ev.text);
        status = "";
      } catch (e) {
        status = "rejected: " + e;      // a monitor denial lands HERE, across the tier
      }
    } else break;
  }
  return "session ended";
}
