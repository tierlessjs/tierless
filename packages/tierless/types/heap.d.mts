import { type Handle, type EncodeTier } from "./graph.mjs";
import { Heap, type Channel, type LocalTier } from "./fetch.mjs";
import { type DeltaFrame, type DeltaRequest } from "./wire-delta.mjs";
export { Channel, makeHost } from "./fetch.mjs";
export interface Tier extends LocalTier, EncodeTier {
    heapGet(hid: string): unknown;
}
export declare function makeTier(id: string): Tier;
export interface EncodeWireOpts {
    tier?: EncodeTier | null;
    threshold?: number;
}
export declare function encodeWire(stack: DeltaFrame[], request: DeltaRequest | null, { tier, threshold }?: EncodeWireOpts): string;
export declare function decodeWire(wire: string): {
    stack: DeltaFrame[];
    request: DeltaRequest | null;
};
export declare const wireHandles: (wire: string) => Handle[];
export declare function writeBack(heap: Heap, id: string, baseVersion: number, value: unknown): {
    ok: boolean;
    version: number;
};
export type CommitWriteResult = {
    ok: true;
    version: number;
    tries: number;
    copy: unknown;
} | {
    ok: false;
    tries: number;
};
export interface CommitWriteOpts {
    tries?: number;
}
export declare function commitWrite(channel: Channel, handle: Handle, mutator: (copy: unknown) => void, { tries }?: CommitWriteOpts): CommitWriteResult;
export interface CoherentHostStats {
    fetches: number;
    hits: number;
    localUses: number;
    writeBacks: number;
    conflicts: number;
    wire: number;
    whole: number;
}
export interface CoherentHost {
    stats: CoherentHostStats;
    deref(h: unknown): unknown;
    writeBack(obj: unknown): unknown;
}
export declare function makeCoherentHost(localTier: LocalTier, channel: Channel): CoherentHost;
