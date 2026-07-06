import { type EncodeOptions } from "./graph.mjs";
import { type Tier } from "./heap.mjs";
import { type Store } from "./store.mjs";
import type { Peer } from "./types.mjs";
export declare const DEREF_TIER = "@deref";
export declare const WRITEBACK_TIER = "@writeback";
export declare const usesHeap: (bundle: unknown) => boolean;
type CacheEntry = {
    version: number;
    copy: unknown;
    bytes: number;
};
export interface CoherenceStats {
    fetches: number;
    hits: number;
    localUses: number;
    bytes: number;
}
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
export declare function makeCoherence(tierId: string, { threshold, store }?: CoherenceOpts): Coherence;
export {};
