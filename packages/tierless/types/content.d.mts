export declare function hashOf(obj: unknown): string;
/** Bytes of shipped views one side holds for a peer before the oldest go (per direction). */
export declare const CONTENT_CACHE_BYTES: number;
export declare class ContentStore {
    private _held;
    private _byObj;
    private _bytes;
    private _budget;
    constructor(budget?: number);
    register(obj: object): string;
    hashFor(obj: object): string | undefined;
    has(h: string): boolean;
    get(h: string): unknown;
    /** receiver: hold a decoded subgraph by hash (and the producer's record of the same: `add`) */
    put(h: string, obj: unknown, size?: number): void;
    add(h: string, size?: number): void;
}
export declare const newPeerView: () => ContentStore;
