export type MaybePromise<T> = T | Promise<T>;
export interface Store<V> {
    get(id: string): MaybePromise<V | undefined>;
    set(id: string, value: V): MaybePromise<void>;
    evict(id: string): MaybePromise<void>;
}
export declare const DEFAULT_CACHE_BYTES: number;
export interface LruOpts<V> {
    /** Eviction budget, in the units `weigh` returns. */
    max: number;
    /** Per-entry weight. Default 1 per entry, i.e. `max` is an entry count. Return byte
     *  size for a memory budget (the served cache weighs each entry by its fetched size). */
    weigh?: (value: V) => number;
}
export declare function makeLruStore<V>(opts: LruOpts<V>): Store<V>;
export declare function makeUnboundedStore<V>(): Store<V>;
