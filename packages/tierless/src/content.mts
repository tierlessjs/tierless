// Content-addressed subgraphs — the wire's third "stays small" move, after §5 handles (big MUTABLE
// data stays home) and delta capture (only the CHANGE travels). Some subgraphs are IMMUTABLE: code,
// class shapes, config. They don't need to travel as bytes more than once — if the peer already holds
// a subgraph's content hash, ship the hash, not the subgraph. Globals already travel this way (a Math
// is shipped by name, never copied); this generalizes it from "things with a well-known name" to "any
// immutable subgraph, named by its content." It is also the known fix for resume identity under version
// skew between tiers (Unison's approach): two tiers that encode the same immutable code agree on its
// hash, so they agree it is the same thing.
//
// Views by content (graph.mts viewOf) use the same store without registration: a plain data view
// (a borrowed library's table) is hashed as it ships, cached by the receiver, and named by its hash
// on every later crossing while its content stands. Browser-safe: the hash is graph.mts Hasher.
import { encodeGraph, Hasher } from "./graph.mjs";

// Canonical content hash of an immutable subgraph. encodeGraph is deterministic for a given object, so
// hashing its encoding yields a stable id; for immutable data, content IS identity. (64 bits as 16 hex
// chars — ample for dedup within a session; widen if you need cross-universe uniqueness.)
export function hashOf(obj: unknown): string {
  return new Hasher().str(JSON.stringify(encodeGraph([obj]))).hex();
}

/** Bytes of shipped views one side holds for a peer before the oldest go (per direction). */
export const CONTENT_CACHE_BYTES = 16 * 1024 * 1024;

// A per-connection store of content-addressed subgraphs, one per direction on each side. The producer
// REGISTERS the immutable roots it might ship (so the codec recognizes them by identity and can name
// them by hash) and ADDS what it shipped by content; the receiver PUTS each one it decodes under the
// same hash. A re-shipped subgraph then resolves to what is already held — identity by content.
//
// The producer's view of the peer and the peer's store MIRROR each other: both admit the same hashes
// in the same order with the same sizes (the size rides the wire), and both drop the oldest past the
// same budget — so a hash the producer says the peer holds, the peer holds. Registered subgraphs are
// unsized (never counted) but queue like the rest.
export class ContentStore {
  private _held: Map<string, { obj: unknown; size: number }>;   // insertion order = admission order
  private _byObj: Map<unknown, string>;
  private _bytes: number;
  private _budget: number;
  constructor(budget: number = CONTENT_CACHE_BYTES) { this._held = new Map(); this._byObj = new Map(); this._bytes = 0; this._budget = budget; }
  register(obj: object): string { const h = hashOf(obj); this.put(h, obj); return h; }   // producer: mark a subgraph immutable
  hashFor(obj: object): string | undefined { return this._byObj.get(obj); }            // encode: registered? -> its hash, else undefined
  has(h: string): boolean { return this._held.has(h); }
  get(h: string): unknown { return this._held.get(h)?.obj; }
  /** receiver: hold a decoded subgraph by hash (and the producer's record of the same: `add`) */
  put(h: string, obj: unknown, size = 0): void {
    if (this._held.has(h)) return;
    this._held.set(h, { obj, size }); this._bytes += size;
    if (obj !== null && typeof obj === "object") this._byObj.set(obj, h);
    for (const [k, e] of this._held) { if (this._bytes <= this._budget) break; this._held.delete(k); this._bytes -= e.size; if (e.obj !== null && typeof e.obj === "object") this._byObj.delete(e.obj); }
  }
  add(h: string, size = 0): void { this.put(h, undefined, size); }
}

// What a producer believes a given peer already holds: the mirror of the peer's store. Encoding ships
// a subgraph inline the first time and adds its hash here; every later capture to the same peer ships
// just the hash.
export const newPeerView = (): ContentStore => new ContentStore();
