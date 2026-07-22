import type { Exec } from "./types.mjs";
export interface EnvelopeStore {
    /** The path->etag index, SYNCHRONOUS — read once at construction, mutated by set().
     *  Sync is load-bearing: an async hydration loses the race to a contended page's
     *  first crossings, which is exactly where the cache matters most. */
    index(): Map<string, string>;
    /** The stored envelope for a path (undefined = evicted/never stored). */
    body(path: string): Promise<unknown>;
    /** Persist an envelope + its etag, and fold the pair into the index. */
    set(path: string, etag: string, envelope: unknown): Promise<void>;
}
export declare const memoryStore: () => EnvelopeStore;
export declare const cacheStorageStore: (cacheName?: string) => EnvelopeStore;
export declare function conditionalCrossings({ store }?: {
    store?: EnvelopeStore;
}): {
    wrap(inner: Exec): Exec;
};
