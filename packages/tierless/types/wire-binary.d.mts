import { type EncodeOptions, type DecodeOptions } from "./graph.mjs";
import type { TwinDelta } from "./types.mjs";
import type { DeltaFrame, DeltaRequest } from "./wire-delta.mjs";
export declare function encodeWireBinary(stack: DeltaFrame[], request: DeltaRequest | null, { tier, threshold, content, excise, deltas }?: EncodeOptions & {
    deltas?: TwinDelta[];
}): Uint8Array;
export declare function decodeWireBinary(bytes: Uint8Array | ArrayBufferLike, { content, tier, programs }?: DecodeOptions): {
    stack: DeltaFrame[];
    request: DeltaRequest | null;
    deltas: TwinDelta[];
};
export declare const encodeArgs: (args: unknown[], opts?: EncodeOptions) => Uint8Array;
export declare const decodeArgs: (bytes: Uint8Array | ArrayBufferLike, opts?: DecodeOptions) => unknown[];
