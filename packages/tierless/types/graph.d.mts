export interface Handle {
    __tierless_handle__: true;
    owner: string;
    id: string;
    kind?: "array" | "object";
}
export declare function isHandle(x: unknown): x is Handle;
export declare const GLOBALS: Record<string, unknown>;
export declare function approxExceeds(root: unknown, limit: number): boolean;
export interface EncodeTier {
    id: string;
    heapPut(v: unknown): string;
}
export interface ContentStoreView {
    hashFor(v: object): string | undefined;
    get(h: string): unknown;
    put(h: string, v: unknown): void;
}
export interface ContentPeerView {
    has(h: string): boolean;
    add(h: string): void;
}
export interface EncodeOptions {
    tier?: EncodeTier | null;
    threshold?: number;
    content?: {
        store: ContentStoreView;
        peer: ContentPeerView;
    } | null;
}
export interface DecodeOptions {
    content?: {
        store: ContentStoreView;
    } | null;
}
export interface EncodedGraph {
    roots: unknown[];
    objs: unknown[];
}
export declare function encodeGraph(values: unknown[], { tier, threshold, content }?: EncodeOptions): EncodedGraph;
export declare function decodeGraph({ roots, objs }: EncodedGraph, { content }?: DecodeOptions): unknown[];
