import { type Handle } from "./graph.mjs";
import { type Store } from "./store.mjs";
export { makeLruStore, makeUnboundedStore, DEFAULT_CACHE_BYTES, type Store, type LruOpts, type MaybePromise } from "./store.mjs";
export interface TierEntry {
    heap: Heap;
}
export type Tiers = Record<string, TierEntry>;
export declare class Heap {
    tierId: string;
    objs: Map<string, unknown>;
    ver: Map<string, number>;
    next: number;
    constructor(tierId: string);
    put(obj: unknown): Handle;
    get(id: string): unknown;
    version(id: string): number;
    mutate(id: string, fn: (obj: unknown) => void): void;
}
export declare class Channel {
    tiers: Tiers;
    bytes: number;
    fetches: number;
    constructor(tiers: Tiers);
    currentVersion(handle: Handle): number;
    fetch(handle: Handle): {
        copy: unknown;
        version: number;
    };
}
export interface LocalTier {
    id: string;
    heap: Heap;
}
export interface HostStats {
    fetches: number;
    hits: number;
    localUses: number;
    bytes: number;
}
export interface FetchHost {
    stats: HostStats;
    deref(h: unknown): unknown;
}
type CacheEntry = {
    version: number;
    copy: unknown;
    bytes: number;
};
export declare function makeHost(localTier: LocalTier, channel: Channel, store?: Store<CacheEntry>): FetchHost;
