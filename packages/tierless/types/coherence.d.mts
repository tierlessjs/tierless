import { type EncodeOptions } from "./graph.mjs";
import { type Tier } from "./heap.mjs";
import { type Session } from "./wire-delta.mjs";
import { type Store } from "./store.mjs";
import type { Peer } from "./types.mjs";
export declare const DEREF_TIER = "@deref";
export declare const WRITEBACK_TIER = "@writeback";
export declare const usesHeap: (bundle: unknown) => boolean;
type CacheEntry = {
    version: number;
    copy: unknown;
    bytes: number;
    session: Session;
};
export interface CoherenceStats {
    fetches: number;
    hits: number;
    localUses: number;
    bytes: number;
    writeBacks: number;
    conflicts: number;
    /** Write-backs that shipped the whole graph and REPLACED the master (baseline was
     *  evicted after the copy went clean, then a later mutation wrote back). Correct under
     *  the CAS, but the owner's direct references to the old master won't see the write. */
    wholeWrites: number;
}
export interface Coherence {
    /** This connection's heap tier — excise into it, serve fetches from it. */
    tier: Tier;
    /** §5 excision options for one continuation's outbound wire: excised ids are tagged
     *  with `sid` so release(sid) frees them when that continuation completes. */
    encodeOpts(sid: string): EncodeOptions;
    /** True for the "@deref"/"@writeback" pseudo-tiers — the host owns and services them here. */
    owns(tier: string): boolean;
    /** Service an "@deref" resource: local master, or a coherent fetch over `peer`. */
    deref(peer: Peer, handle: unknown): Promise<unknown>;
    /** Service an "@writeback" resource: propose the mutated snapshot to its owner (CAS). */
    writeBack(peer: Peer, obj: unknown): Promise<unknown>;
    /** Drop the excised masters a completed continuation created (owner-side bounding). */
    release(sid: string): void;
    /** Tell the peer a continuation completed, so IT releases the excisions it holds for it. */
    releaseRemote(peer: Peer, sid: string): void;
    /** Register the responders for deref / writeback / release requests against this heap. */
    serve(peer: Peer): void;
    stats: CoherenceStats;
}
export interface CoherenceOpts {
    /** Excise locals larger than this many bytes into the heap as handles (default 8 KiB). */
    threshold?: number;
    /** The bounded reader cache (default: byte-weighted LRU at DEFAULT_CACHE_BYTES, with
     *  dirty entries pinned). Custom stores should honor the same pin (see LruOpts.evictable)
     *  or dirty write-backs degrade to whole-graph replaces. */
    store?: Store<CacheEntry>;
}
export declare function makeCoherence(tierId: string, { threshold, store }?: CoherenceOpts): Coherence;
export {};
