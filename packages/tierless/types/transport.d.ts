// tierless/transport — WebSocket framing + RPC peer (browser-safe).
import type { Peer } from "./index.js";
export function encodeMessage(obj: object, bin?: Uint8Array): Uint8Array;
export function decodeMessage(data: ArrayBuffer | Uint8Array): { obj: any; bin: Uint8Array | null };
export function wsPort(ws: unknown): { send(obj: object, bin?: Uint8Array): void; onMessage(cb: (obj: any, bin: Uint8Array | null) => void): void; onClose(cb: () => void): void; close(): void };
export function makePeer(port: ReturnType<typeof wsPort>): Peer;
export type { Peer };
