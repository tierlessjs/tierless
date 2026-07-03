import type { Peer } from "./types.mjs";
export type { Peer } from "./types.mjs";
export declare function encodeMessage(obj: object, bin?: Uint8Array | ArrayBufferLike): Uint8Array;
export declare function decodeMessage(data: ArrayBuffer | Uint8Array): {
    obj: any;
    bin: Uint8Array | null;
};
export declare function onEvent(ws: any, event: string, fn: (...args: any[]) => void): unknown;
export interface Port {
    send(obj: object, bin?: Uint8Array): void;
    onMessage(cb: (obj: any, bin: Uint8Array | null) => void): void;
    onClose(cb: () => void): void;
    close(): void;
}
export declare function wsPort(ws: any): Port;
export declare function makePeer(port: Port): Peer;
