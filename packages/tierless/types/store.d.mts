export type MaybePromise<T> = T | Promise<T>;
export interface Store<V> {
    get(id: string): MaybePromise<V | undefined>;
    set(id: string, value: V): MaybePromise<void>;
    evict(id: string): MaybePromise<void>;
}
export declare const DEFAULT_CACHE_CAP = 4096;
export declare function makeLruStore<V>(cap?: number): Store<V>;
export declare function makeUnboundedStore<V>(): Store<V>;
