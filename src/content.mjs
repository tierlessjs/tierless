// Content-addressed subgraphs — the wire's third "stays small" move, after §5 handles (big MUTABLE
// data stays home) and delta capture (only the CHANGE travels). Some subgraphs are IMMUTABLE: code,
// class shapes, config. They don't need to travel as bytes more than once — if the peer already holds
// a subgraph's content hash, ship the hash, not the subgraph. Globals already travel this way (a Math
// is shipped by name, never copied); this generalizes it from "things with a well-known name" to "any
// immutable subgraph, named by its content." It is also the known fix for resume identity under version
// skew between tiers (Unison's approach): two tiers that encode the same immutable code agree on its
// hash, so they agree it is the same thing.
import { createHash } from "node:crypto";
import { encodeGraph } from "./graph.mjs";

// Canonical content hash of an immutable subgraph. encodeGraph is deterministic for a given object, so
// hashing its encoding yields a stable id; for immutable data, content IS identity. (Truncated to 16
// hex chars — 64 bits, ample for dedup within a session; widen if you need cross-universe uniqueness.)
export function hashOf(obj) {
  return createHash("sha256").update(JSON.stringify(encodeGraph([obj]))).digest("hex").slice(0, 16);
}

// A per-tier store of content-addressed immutable subgraphs. The producer REGISTERS the immutable roots
// it might ship (so the codec recognizes them by identity and can name them by hash); the receiver PUTS
// each one it decodes under the same hash. A re-shipped subgraph then resolves to the copy already held
// — identity by content.
export class ContentStore {
  constructor() { this._byHash = new Map(); this._byObj = new Map(); }
  register(obj) { const h = hashOf(obj); this._byHash.set(h, obj); this._byObj.set(obj, h); return h; }   // producer: mark a subgraph immutable
  hashFor(obj) { return this._byObj.get(obj); }                                                            // encode: registered? -> its hash, else undefined
  has(h) { return this._byHash.has(h); }
  get(h) { return this._byHash.get(h); }
  put(h, obj) { if (!this._byHash.has(h)) { this._byHash.set(h, obj); this._byObj.set(obj, h); } }         // receiver: cache a decoded subgraph by hash
}

// What a producer believes a given peer already holds. Encoding ships a registered subgraph inline the
// first time and adds its hash here; every later capture to the same peer ships just the hash.
export const newPeerView = () => new Set();
