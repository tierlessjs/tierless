import { type EncodeOptions, type DecodeOptions } from "./graph.mjs";
import type { DeltaFrame, DeltaRequest } from "./wire-delta.mjs";
export declare function encodeWireBinary(stack: DeltaFrame[], request: DeltaRequest | null, { tier, threshold, content, excise }?: EncodeOptions): Uint8Array;
export declare function decodeWireBinary(bytes: Uint8Array | ArrayBufferLike, { content, tier }?: DecodeOptions): {
    stack: DeltaFrame[];
    request: DeltaRequest | null;
};
export declare const encodeArgs: (args: unknown[], opts?: EncodeOptions) => Uint8Array;
export declare const decodeArgs: (bytes: Uint8Array | ArrayBufferLike) => unknown[];
