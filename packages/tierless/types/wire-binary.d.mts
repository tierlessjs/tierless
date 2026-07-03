import { type EncodeOptions, type DecodeOptions } from "./graph.mjs";
import type { DeltaFrame, DeltaRequest } from "./wire-delta.mjs";
export declare function encodeWireBinary(stack: DeltaFrame[], request: DeltaRequest | null, { tier, threshold, content }?: EncodeOptions): Uint8Array;
export declare function decodeWireBinary(bytes: Uint8Array | ArrayBufferLike, { content }?: DecodeOptions): {
    stack: DeltaFrame[];
    request: DeltaRequest | null;
};
