export interface Handle {
    __tierless_handle__: true;
    owner: string;
    id: string;
    kind?: "array" | "object";
    /** Class identity of an excised compiled-class instance (the __tierless_cls stamp):
     *  what a dynamic call park dispatches on without the live object (migrate-arm.md). */
    cls?: string;
    /** For an excised PLAIN object: the class of each own member that is a direct instance
     *  of a stamped class. A captured-variables object (a compiled closure's __caps) excises
     *  whole — so writes to shared state stay on the live object at home — and this is what
     *  lets the far side still reach a TWIN of one member (caps.adminClient) by path. */
    mcls?: Record<string, string>;
    /** For each mcls member: a JSON image of its own data fields (functions and
     *  unserializable values stay home). The twin factory applies what it trusts, so a
     *  twin serves the call with the live object's state at the moment it shipped — the
     *  mirror of the twin deltas that carry the twin's writes back. */
    mstate?: Record<string, string>;
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
    /** §5 excision by OWNERSHIP, not size: a value this predicate claims stays home as a
     *  handle regardless of its size (functions always consult it — they otherwise cross
     *  as undefined). The migrate arm passes an ownsValues-style scan here so live
     *  instances and callbacks keep their identity across a round trip. Needs `tier`. */
    excise?: ((v: unknown) => boolean) | null;
}
export interface DecodeOptions {
    content?: {
        store: ContentStoreView;
    } | null;
    /** Resolve handles OWNED HERE back to the live object (master in place): a stack
     *  coming home gets its excised locals back by identity. Foreign handles stay opaque.
     *  An owned handle the heap no longer holds throws — a corrupt session, never a
     *  silently different object. */
    tier?: {
        id: string;
        heapGet(hid: string): unknown;
    } | null;
}
export interface EncodedGraph {
    roots: unknown[];
    objs: unknown[];
}
export declare function encodeGraph(values: unknown[], { tier, threshold, content, excise }?: EncodeOptions): EncodedGraph;
export declare function toBigInt(s: string): bigint;
export declare function decodeGraph({ roots, objs }: EncodedGraph, { content, tier }?: DecodeOptions): unknown[];
