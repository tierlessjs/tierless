// Mediated migration toward authority (design §7). When a continuation migrates from the UNTRUSTED
// browser tier to the trusted server tier, the server must treat the incoming { stack, request } as
// hostile DATA, not code. It already never executes client code — it runs its OWN compiled PROGRAMS
// by name — but a malicious client can forge the frame stack, the suspended request, or a §5 handle.
// makeGuard() is the acceptance check the server runs before resuming:
//
//   • well-formedness — every frame names a KNOWN program with an integer pc and a sane handler
//     stack; a forged/garbage frame is rejected (and a forged pc that slips through is caught at
//     resume by the machine's `default: throw` guard — never an infinite loop);
//   • resource allow-list — the suspended request must name a resource this tier actually exposes,
//     for this tier; a fabricated name (api.dropEverything) is rejected before any handler runs;
//   • handle capabilities — a §5 handle owned by this tier is honored ONLY if this host MINTED it to
//     the peer (guard.mint on excision). A forged id is rejected, so the peer can't read arbitrary
//     heap objects by guessing ids — the id is a capability, not an address.
//
// What the framework CANNOT decide is per-call authority (may THIS session delete THIS article): that
// is the resource handler's job — and because a forged pc can jump the continuation to any resource
// the app uses anywhere, handlers must authorize each call themselves, never trust the control flow
// that reached them. The guard guarantees only that a handler runs on well-formed input it permitted.
import { isHandle } from "./graph.mjs";

export class SecurityError extends Error { constructor(m) { super(m); this.name = "SecurityError"; } }

// Collect every §5 handle reachable in the continuation (cycle-safe; objects/arrays/Map/Set).
function handlesIn(roots) {
  const out = [], seen = new Set();
  const walk = (v) => {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (isHandle(v)) { out.push(v); return; }                      // a handle is a leaf
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v instanceof Map) { for (const [k, val] of v) { walk(k); walk(val); } return; }
    if (v instanceof Set) { for (const e of v) walk(e); return; }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  roots.forEach(walk);
  return out;
}

export function makeGuard({ programs, resources, tier, maxDepth = 1024 }) {
  const allowed = resources instanceof Set ? resources : new Set(resources);
  const issued = new Set();                                        // §5 handle ids this host minted to the peer (capabilities)
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const checkHandlers = (h) => {
    if (!Array.isArray(h)) throw new SecurityError("malformed handler stack");
    for (const e of h) {
      if (!e || typeof e !== "object") throw new SecurityError("malformed handler entry");
      for (const k of ["catch", "fin"]) if (e[k] != null && (!Number.isInteger(e[k]) || e[k] < 0)) throw new SecurityError("bad handler pc");
    }
  };
  const checkFrame = (f) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new SecurityError("malformed frame");
    if (typeof f.fn !== "string" || !has(programs, f.fn)) throw new SecurityError("unknown program: " + JSON.stringify(f && f.fn));
    if (!Number.isInteger(f.pc) || f.pc < 0) throw new SecurityError("non-integer / negative pc: " + JSON.stringify(f.pc));
    if (f.__h !== undefined) checkHandlers(f.__h);
  };

  return {
    // mint/revoke a §5 handle capability — call mint(id) whenever the server excises a handle to the peer
    mint(id) { issued.add(String(id)); return id; },
    revoke(id) { issued.delete(String(id)); },
    issuedCount() { return issued.size; },

    // throw SecurityError if the incoming { stack, request } is forged/hostile; return it if accepted
    check(incoming) {
      if (!incoming || typeof incoming !== "object") throw new SecurityError("malformed continuation");
      const { stack, request } = incoming;
      if (!Array.isArray(stack) || stack.length === 0) throw new SecurityError("stack is not a non-empty array");
      if (stack.length > maxDepth) throw new SecurityError("stack too deep (" + stack.length + " > " + maxDepth + ")");
      for (const f of stack) checkFrame(f);

      const roots = stack.slice();
      if (request && Array.isArray(request.args)) roots.push(...request.args);
      for (const h of handlesIn(roots)) {
        if (h.owner === tier && !issued.has(String(h.id))) throw new SecurityError("forged handle: " + tier + "#" + h.id + " was never issued to this peer");
      }

      if (request != null) {
        if (typeof request !== "object") throw new SecurityError("malformed request");
        if (request.tier !== tier) throw new SecurityError("request tier " + JSON.stringify(request.tier) + " is not this tier (" + tier + ")");
        if (typeof request.name !== "string" || !allowed.has(request.name)) throw new SecurityError("unauthorized resource: " + JSON.stringify(request && request.name));
      }
      return incoming;
    },
  };
}
