import type { Exec } from "./types.mjs";
interface Entry {
    etag: string;
    envelope: unknown;
}
export interface EnvelopeStore {
    get(path: string): Promise<Entry | undefined>;
    set(path: string, entry: Entry): Promise<void>;
}
export declare const memoryStore: () => EnvelopeStore;
export declare const cacheStorageStore: (cacheName?: string) => EnvelopeStore;
export declare function conditionalCrossings({ store }?: {
    store?: EnvelopeStore;
}): {
    wrap(inner: Exec): Exec;
};
export {};
