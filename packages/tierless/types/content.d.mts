export declare function hashOf(obj: unknown): string;
export declare class ContentStore {
    private _byHash;
    private _byObj;
    constructor();
    register(obj: object): string;
    hashFor(obj: object): string | undefined;
    has(h: string): boolean;
    get(h: string): unknown;
    put(h: string, obj: unknown): void;
}
export declare const newPeerView: () => Set<string>;
