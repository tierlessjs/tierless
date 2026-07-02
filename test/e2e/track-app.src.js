// Plain source for the --track-writes proof: an oscillating session that MUTATES its continuation
// IN PLACE on every hop — there is not a single touch()/writeBack()/deref() here. The model object
// is created once and kept across hops (stable identity), and each event edits it: a field update,
// a deep member assignment, and array mutators. Compiled with --track-writes the compiler wraps each
// of those mutations in __dirty(obj), so the delta wire's write-tracked mode ships only the changed
// objects with no graph re-hash. commit() suspends each hop, making the continuation cross the tier
// boundary repeatedly — the exact oscillation delta encoding is for.
//
//   node transform.cjs track-app.src.js track-app.gen.mjs --bare --track-writes
//
// touchCount is a PURE (non-suspendable) helper that mutates an EXISTING continuation object passed
// across the call boundary — proving the compiler instruments pure helpers too, so an in-place edit
// inside one is not silently missed (it bumps the object the same way).
function touchCount(item) {
  item.touches = (item.touches || 0) + 1;                 // in-place mutation of a caller-owned object
}
function Session() {
  const model = { items: [], log: [], hops: 0, last: null, byId: new Map(), doneIds: new Set() };
  while (true) {
    const ev = commit(model);                              // suspend: hand the continuation across the boundary
    if (ev.type === "stop") break;
    model.hops = model.hops + 1;                           // field update (assignment through a local)
    model.last = ev.type;
    if (ev.type === "add") {
      const item = { id: ev.id, label: ev.label, done: false };
      model.items.push(item);                                          // array mutator (push)
      model.byId.set(ev.id, item);                                     // Map mutator (set)
    } else if (ev.type === "toggle") {
      const item = model.items[ev.idx];
      item.done = !item.done;                                          // deep member assignment
      touchCount(item);                                               // mutation through a pure helper
      if (item.done) model.doneIds.add(item.id);                       // Set mutator (add)
      else model.doneIds.delete(item.id);                             // Set mutator (delete)
    } else if (ev.type === "rename") {
      model.items[ev.idx].label = ev.label;                           // deep member assignment
      touchCount(model.items[ev.idx]);                                 // mutation through a pure helper
    } else if (ev.type === "tick") {
      model.log.push("tick " + model.hops);                           // array mutator on a different object
    } else if (ev.type === "clear") {
      model.items.splice(0, model.items.length);                      // array mutator (splice)
      model.byId.clear();                                             // Map mutator (clear)
      model.doneIds.clear();                                          // Set mutator (clear)
    }
  }
  return model.hops;
}
