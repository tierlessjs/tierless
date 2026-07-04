import { type Handle, type EncodeTier, type ContentStoreView } from "./graph.mjs";
export interface DeltaFrame {
    fn: string;
    pc: number;
    [key: string]: unknown;
}
export interface DeltaRequest {
    op: string;
    tier: string;
    name: string;
    args?: unknown[];
}
export interface Session {
    tier: string;
    idOf: WeakMap<object, string>;
    next: number;
    store: Map<string, unknown>;
    handleOf: WeakMap<object, Handle>;
    fields: boolean;
    peerSlots: Map<string, Slots>;
    peerVer?: Map<string, number>;
    seen?: Set<string>;
    dirty?: Set<object>;
    based?: boolean;
}
export interface DeltaOpts {
    tier?: EncodeTier;
    threshold?: number;
}
export interface PlanDeltaOpts extends DeltaOpts {
    exact?: boolean;
}
type Slots = Map<string | number, {
    key: unknown;
    canon: string;
}>;
export declare function makeDeltaSession(tier: string): Session;
export declare function encodeDelta(session: Session, stack: DeltaFrame[], request: DeltaRequest | null, opts?: DeltaOpts): {
    bytes: Uint8Array;
    reachable: number;
    shipped: number;
};
export declare function applyDelta(session: Session, bytes: Uint8Array | ArrayBufferLike): {
    stack: DeltaFrame[];
    request: DeltaRequest | null;
};
export declare function makeTrackedSession(tier: string): Session;
export declare function touch<T extends unknown[]>(session: Session, ...objs: T): T[0];
export declare function planDelta(session: Session, stack: DeltaFrame[], request: DeltaRequest | null, opts?: PlanDeltaOpts): {
    bytes: Uint8Array;
    shipped: number;
    visited: number;
    commit(): void;
};
export declare function encodeDeltaTracked(session: Session, stack: DeltaFrame[], request: DeltaRequest | null, opts?: PlanDeltaOpts): {
    bytes: Uint8Array;
    shipped: number;
    visited: number;
};
export declare function applyDeltaTracked(session: Session, bytes: Uint8Array | ArrayBufferLike): {
    stack: DeltaFrame[];
    request: DeltaRequest | null;
};
export declare function adoptBaseline(session: Session, stack: DeltaFrame[], request: DeltaRequest | null): void;
export declare function subForFullWire(session: Session, stack: DeltaFrame[], request: DeltaRequest | null, content?: {
    store: ContentStoreView;
} | null): {
    stack: DeltaFrame[];
    request: DeltaRequest | null;
};
export declare function exciseForCapture(session: Session, stack: DeltaFrame[], request: DeltaRequest | null, tier: EncodeTier, threshold?: number, content?: {
    store: ContentStoreView;
} | null): void;
export declare function openSnapshot(tierId: string, value: unknown): Session;
export declare function diffSnapshot(session: Session, value: unknown): Uint8Array;
export declare function wholeSnapshot(session: Session, value: unknown): Uint8Array;
export declare function applySnapshot(tierId: string, master: unknown, bytes: Uint8Array | ArrayBufferLike): unknown;
export {};
