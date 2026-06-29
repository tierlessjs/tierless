// Plain source for the LIVE delta demo. Unlike track-app (which only commits), this loop touches a
// SERVER resource (api.poll) AND a BROWSER resource (commit) every iteration, so the continuation
// BOUNCES server→browser→server across the real socket each hop — the oscillation delta encoding is
// for. The model is built once and mutated IN PLACE every hop (push, deep assign, Map.set), with no
// touch()/deref() anywhere; --track-writes makes each mutation bump, so each crossing ships a delta.
//
//   node transform.cjs delta-app.src.js delta-app.gen.mjs --bare --track-writes
function Board() {
  const model = { rows: [], log: [], hops: 0, cursor: 0, byId: new Map() };
  while (true) {
    const data = api.poll(model.cursor);            // SERVER resource — returns the next scripted change
    if (data.stop) break;
    model.hops = model.hops + 1;
    model.cursor = data.cursor;
    if (data.kind === "add") {
      const row = { id: data.id, label: data.label, hot: false };
      model.rows.push(row);                          // array mutator
      model.byId.set(data.id, row);                  // Map mutator
    } else if (data.kind === "heat") {
      model.rows[data.idx].hot = true;               // deep member assignment
    } else if (data.kind === "label") {
      model.rows[data.idx].label = data.label;       // deep member assignment
    }
    const ev = commit(model);                        // BROWSER resource — bounce; render + interaction
    model.log.push(ev.note);                         // array mutator (on the browser side)
    if (ev.done) break;
  }
  return model.hops;
}
