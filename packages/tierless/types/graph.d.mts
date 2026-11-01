export interface Handle {
    __tierless_handle__: true;
    owner: string;
    id: string;
    kind?: "array" | "object" | "function";
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
export declare function shareFunction(name: string, fn: Function): void;
export declare function shareClass(name: string, cls: {
    prototype: object;
}): void;
export declare function protoFor(cls: string, err: boolean): object | undefined;
export declare const VIEW: unique symbol;
export declare function hydrated(twin: object, handle: Handle): void;
/** The home handle of a twin on this tier (a session twin hydrated into a view, or a value
 *  twin a shipped closure brought), or undefined for any other object. */
export declare function twinOf(o: object): Handle | undefined;
interface CompiledFn {
    __tierless_program: string;
    __tierless_caps: () => unknown;
    __tierless_sync: true;
}
export declare const isCompiledFn: (v: unknown) => v is CompiledFn;
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
    /** This tier's compiled programs, for a shipped sync closure (slot "fn"): a runner for
     *  the named program, or undefined when this tier's bundle doesn't hold it (the stub
     *  then throws when called). */
    programs?: ((name: string) => ((caps: unknown, args: unknown[]) => unknown) | undefined) | null;
}
export interface EncodedGraph {
    roots: unknown[];
    objs: unknown[];
}
export declare function encodeGraph(values: unknown[], { tier, threshold, content, excise }?: EncodeOptions): EncodedGraph;
export declare function toBigInt(s: string): bigint;
export declare function decodeGraph({ roots, objs }: EncodedGraph, { content, tier, programs }?: DecodeOptions): unknown[];
export {};
