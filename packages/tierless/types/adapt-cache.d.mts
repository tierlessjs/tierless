import type { Exec } from "./types.mjs";
interface Fence {
    request(name: string, cb: () => void | Promise<void>): Promise<unknown>;
}
export interface EnvelopeStore {
    /** The path->etag index, SYNCHRONOUS — read once at construction, mutated by set().
     *  Sync is load-bearing: an async hydration loses the race to a contended page's
     *  first crossings, which is exactly where the cache matters most. */
    index(): Map<string, string>;
    /** The stored envelope for a path (undefined = evicted/never stored). */
    body(path: string): Promise<unknown>;
    /** Persist an envelope + its etag, and fold the pair into the index. MUST write the
     *  body before the index — that ordering is what makes an abandoned write a clean
     *  miss. `bodyText`, when given, is the body's ORIGINAL JSON text (transport.mts
     *  RAW_TEXT) — store it as-is instead of re-serializing the parsed body. */
    set(path: string, etag: string, envelope: unknown, bodyText?: string): Promise<void>;
    /** Re-read the durable index into the live Map (synchronously). Called when the
     *  previous page's write fence clears, so this page picks up writes that were still
     *  in flight when it constructed. Optional: a store without one just serves its
     *  construction-time index. */
    refresh?(): void;
}
export declare const memoryStore: () => EnvelopeStore;
export declare const cacheStorageStore: (cacheName?: string) => EnvelopeStore;
export declare function conditionalCrossings({ store, fence }?: {
    store?: EnvelopeStore;
    fence?: Fence;
}): {
    wrap(inner: Exec): Exec;
};
export {};
