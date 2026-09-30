export interface Handle {
    __tierless_handle__: true;
    owner: string;
    id: string;
    kind?: "array" | "object";
    /** Class identity of an excised compiled-class instance (the __tierless_cls stamp):
     *  what a dynamic call park dispatches on without the live object (migrate-arm.md). */
    cls?: string;
    /** An ownership-excised PLAIN object (a compiled closure's caps): how the far side may see
     *  it, as JSON { p: primitive members by value, c: stamped members' classes, s: those
     *  members' data fields, o: every other member's name }. The object still excises whole —
     *  writes to its members only ever happen at home — but off-tier it decodes as a VIEW
     *  (decodeGraph): primitives readable in place, other members as member handles. */
    view?: string;
    /** A MEMBER handle (one of a view's non-primitive members): its path from the handle's
     *  object. Resolves at home to heapGet(id)[path…]. */
    path?: string[];
    /** A stamped member handle's data fields as they shipped, for its twin. Not re-encoded. */
    state?: Record<string, unknown>;
}
/** Stamp a class's identity and register it on THIS tier, so its instances keep their class
 *  when copied across tiers — and, as a §5 handle's `cls`, can dispatch to a session twin. */
export declare function shareClass(name: string, cls: {
    prototype: object;
}): void;
export declare function protoFor(cls: string, err: boolean): object | undefined;
export declare const VIEW: unique symbol;
export declare function hydrated(twin: object, handle: Handle): void;
export declare function isHandle(x: unknown): x is Handle;
export declare const GLOBALS: Record<string, unknown>;
/** `claimed` (the encoder's excise predicate) marks values that ship as a handle whatever
 *  their size: they cost a handle here, and their graph is not walked. Without it a small
 *  frame args array holding a borrowed service ([caps, first, max]) measured the service's
 *  whole reachable graph — Keycloak's admin client is far over 8 KB — and the ARGS ARRAY
 *  itself was excised, so the far side saw F.args as a handle and F.args[0] as undefined. */
export declare function approxExceeds(root: unknown, limit: number, claimed?: ((v: unknown) => boolean) | null): boolean;
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
