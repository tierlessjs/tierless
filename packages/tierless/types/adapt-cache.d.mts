import type { Exec } from "./types.mjs";
export interface EnvelopeStore {
    /** The path->etag index, SYNCHRONOUS — read once at construction, mutated by set().
     *  Sync is load-bearing: an async hydration loses the race to a contended page's
     *  first crossings, which is exactly where the cache matters most. */
    index(): Map<string, string>;
    /** The stored envelope for a path (undefined = evicted/never stored). */
    body(path: string): Promise<unknown>;
    /** Persist an envelope + its etag, and fold the pair into the index. `bodyText`, when
     *  given, is the body's ORIGINAL JSON text (transport.mts RAW_TEXT) — store it as-is
     *  instead of re-serializing the parsed body. */
    set(path: string, etag: string, envelope: unknown, bodyText?: string): Promise<void>;
}
export declare const memoryStore: () => EnvelopeStore;
export declare const cacheStorageStore: (cacheName?: string) => EnvelopeStore;
export declare function conditionalCrossings({ store }?: {
    store?: EnvelopeStore;
}): {
    wrap(inner: Exec): Exec;
};
