// Tierless — §5 heap coherence for the LIVE session host (the real serving path).
//
// A continuation that migrates carries §5 handles: big locals excised to their owning
// tier's heap so they don't travel (heap.mjs / graph.mjs excision). When the other tier
// touches one, the compiler's --auto-deref pass emits a `deref` resource under the pseudo
// tier "@deref" — a marker for "service this locally, on whatever tier is running." This
// module is what the session host (host.mjs) plugs in to service it for real, over the
// SAME websocket the continuation rides:
//
//   • encodeOpts   — excise big locals into this connection's heap on the outbound wire.
//   • serve(peer)  — answer a peer's `deref` request from this heap (single-writer,
//                    version-invalidated: reply "same" on a version match, else the graph).
//   • deref(peer)  — service an "@deref": the local master if we own it, else fetch the
//                    snapshot over `peer` and cache it in a BYTE-BOUNDED store, so a long
//                    session dereferencing many distinct handles stays within a memory
//                    budget (release across sessions is the per-socket host lifetime).
//
// This replaces the in-process `Channel` model of fetch.mjs/heap.mjs (a test-only
// shortcut that reaches into the other tier's heap in the same process) with the real
// cross-socket fetch. The reader cache is the bounded store; the OWNER-side excision heap
// (this connection's `tier.heap`) is bounded by connection lifetime — evicting a live
// excised local would strand a reader's fetch, so a within-session bound there needs
// liveness tracking (a separate design, like the write-back baselines).
import { encodeGraph, decodeGraph, isHandle, type EncodeOptions } from "./graph.mjs";
import { makeTier, type Tier } from "./heap.mjs";
import { makeLruStore, DEFAULT_CACHE_BYTES, type Store } from "./store.mjs";
import type { Peer } from "./types.mjs";

// The pseudo-tier the --auto-deref compiler stamps on a handle read (see the compiled
// machines: `{ op:"resource", tier:"@deref", name:"deref", args:[local] }`).
export const DEREF_TIER = "@deref";
// The pseudo-tier --auto-writeback stamps on a mutation. NOT yet served on the live path
// (the CAS write-back over the socket is designed but unbuilt — docs/memory.md). The host
// owns it only to fail with a clear diagnostic instead of bouncing the request into the
// app's exec on the other tier, which reads as a missing app resource.
export const WRITEBACK_TIER = "@writeback";

// Whether a compiled bundle was built with --auto-deref: the pass exports an `isHandle`
// guard onto the module. The host uses this to auto-enable coherence for the apps that
// need it, leaving ordinary apps (no handles, no deref) exactly as they were.
export const usesHeap = (bundle: unknown): boolean =>
  !!bundle && typeof (bundle as { isHandle?: unknown }).isHandle === "function";

type CacheEntry = { version: number; copy: unknown; bytes: number };

export interface CoherenceStats { fetches: number; hits: number; localUses: number; bytes: number }
export interface Coherence {
  /** This connection's heap tier — excise into it, serve fetches from it. */
  tier: Tier;
  /** §5 excision options for the outbound continuation wire. */
  encodeOpts: EncodeOptions;
  /** True for the "@deref" pseudo-tier — the host owns it and services it here. */
  ownsDeref(tier: string): boolean;
  /** Service an "@deref" resource: local master, or a coherent fetch over `peer`. */
  deref(peer: Peer, handle: unknown): Promise<unknown>;
  /** Register the responder that answers other tiers' `deref` requests from this heap. */
  serve(peer: Peer): void;
  stats: CoherenceStats;
}

export interface CoherenceOpts {
  /** Excise locals larger than this many bytes into the heap as handles (default 8 KiB). */
  threshold?: number;
  /** The bounded reader cache (default: byte-weighted LRU at DEFAULT_CACHE_BYTES). */
  store?: Store<CacheEntry>;
}

export function makeCoherence(tierId: string, { threshold = 8192, store = makeLruStore<CacheEntry>({ max: DEFAULT_CACHE_BYTES, weigh: (e) => e.bytes }) }: CoherenceOpts = {}): Coherence {
  const tier = makeTier(tierId);
  const stats: CoherenceStats = { fetches: 0, hits: 0, localUses: 0, bytes: 0 };
  return {
    tier,
    encodeOpts: { tier, threshold },
    ownsDeref: (t: string): boolean => t === DEREF_TIER,
    async deref(peer: Peer, h: unknown): Promise<unknown> {
      if (!isHandle(h)) return h;
      if (h.owner === tier.id) { stats.localUses++; return tier.heap.get(h.id); }         // we own the master — use it in place
      // Consult the owner with the version we hold; it ships the graph only on a miss.
      const cached = (await store.get(h.id)) as CacheEntry | undefined;
      const { obj } = await peer.request({ type: "deref", id: h.id, have: cached ? cached.version : -1 });
      if (obj.type === "same") { stats.hits++; return (cached as CacheEntry).copy; }        // version match — the cached copy is still coherent
      const copy = decodeGraph(obj.graph)[0];                                               // identity/cycle-safe snapshot
      const bytes = JSON.stringify(obj.graph).length;                                       // wire size — the entry's memory weight
      await store.set(h.id, { version: obj.version, copy, bytes });
      stats.fetches++; stats.bytes += bytes;
      return copy;
    },
    serve(peer: Peer): void {
      // Single-writer coherence: the owner bumps a version on mutation; a reader that still
      // holds the current version needs no data, so answer "same" and ship nothing.
      peer.on("deref", (req: { id: string; have: number }) => {
        const version = tier.heap.version(req.id);
        if (req.have === version) return { obj: { type: "same", version } };
        return { obj: { type: "fetchResult", version, graph: encodeGraph([tier.heapGet(req.id)]) } };
      });
    },
    stats,
  };
}
