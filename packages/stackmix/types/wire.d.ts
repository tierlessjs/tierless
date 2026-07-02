// stackmix/wire — the compact binary wire (what crosses the socket).
import type { Frame, ResourceRequest } from "./index.js";
export function encodeWireBinary(stack: Frame[], request: object, opts?: object): Uint8Array;
export function decodeWireBinary(bin: Uint8Array, opts?: object): { stack: Frame[]; request: ResourceRequest & Record<string, unknown> };
