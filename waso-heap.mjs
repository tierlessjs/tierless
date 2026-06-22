// Waso — identity-preserving, cycle-safe graph codec for continuation state.
//
// The naive wire format (per-value JSON) loses object identity (shared refs
// become separate copies) and throws on cycles — see probe-heap.mjs. A real
// continuation references an object graph with sharing and cycles, so the wire
// format must encode the GRAPH, not each value independently.
//
// encodeGraph(values, {tier, threshold}) walks all values reachable from the
// roots, assigns each distinct object/array an id, and emits a flat table where
// every reference is an {k:"r", id}. That:
//   - preserves identity   : the same object is one table entry, referenced by id
//   - survives cycles      : an object's id is reserved before its fields recurse
//   - keeps continuations small : a subgraph bigger than `threshold` becomes a §5
//     handle into the owning tier's heap (a leaf — it stays tier-local)
// The encoded form is acyclic and JSON-safe; decodeGraph rebuilds the graph,
// pre-creating each object so cycles and sharing are restored exactly.

export function isHandle(x) {
  return x !== null && typeof x === "object" && x.__waso_handle__ === true;
}

// Cycle-safe, early-exiting size estimate (never JSON.stringify a cyclic graph).
function approxExceeds(root, limit) {
  let total = 0;
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const x = stack.pop();
    if (x === null || typeof x !== "object") { total += typeof x === "string" ? x.length : 8; if (total > limit) return true; continue; }
    if (seen.has(x)) continue;
    seen.add(x);
    total += 16; if (total > limit) return true;
    if (Array.isArray(x)) { for (const e of x) stack.push(e); }
    else for (const k of Object.keys(x)) { total += k.length; stack.push(x[k]); }
  }
  return false;
}

export function encodeGraph(values, { tier = null, threshold = 64 * 1024 } = {}) {
  const objs = [];          // id -> { k:"a"|"o"|"H", ... }
  const idOf = new Map();   // object -> id (identity + cycle handling)

  function enc(v) {
    if (v === undefined) return { k: "u" };
    if (v === null || typeof v !== "object") return { k: "p", v };
    if (idOf.has(v)) return { k: "r", id: idOf.get(v) };
    if (isHandle(v)) { const id = objs.length; idOf.set(v, id); objs.push({ k: "H", h: v }); return { k: "r", id }; }
    // big subgraph -> §5 handle into the owning tier's heap (stays tier-local)
    if (tier && approxExceeds(v, threshold)) {
      const id = objs.length; idOf.set(v, id);
      objs.push({ k: "H", h: { __waso_handle__: true, owner: tier.id, id: tier.heapPut(v), kind: Array.isArray(v) ? "array" : "object" } });
      return { k: "r", id };
    }
    const id = objs.length; idOf.set(v, id);              // reserve id BEFORE recursing (cycle-safe)
    if (Array.isArray(v)) { const slot = { k: "a", e: [] }; objs.push(slot); slot.e = v.map(enc); return { k: "r", id }; }
    const slot = { k: "o", f: {} }; objs.push(slot);
    for (const key of Object.keys(v)) slot.f[key] = enc(v[key]);
    return { k: "r", id };
  }

  return { roots: values.map(enc), objs };
}

export function decodeGraph({ roots, objs }) {
  const built = objs.map((s) => (s.k === "a" ? [] : s.k === "o" ? {} : s.h)); // pre-create for cycles/sharing
  const dec = (n) => (n.k === "u" ? undefined : n.k === "p" ? n.v : built[n.id]);
  objs.forEach((s, i) => {
    if (s.k === "a") for (const n of s.e) built[i].push(dec(n));
    else if (s.k === "o") for (const key in s.f) built[i][key] = dec(s.f[key]);
    // k:"H" -> built[i] is already the handle object
  });
  return roots.map(dec);
}
