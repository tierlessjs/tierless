import type { Peer } from "./types.mjs";
export type { Peer } from "./types.mjs";
export declare function encodeMessage(obj: object, bin?: Uint8Array | ArrayBufferLike): Uint8Array;
export declare function decodeMessage(data: ArrayBuffer | Uint8Array): {
    obj: any;
    bin: Uint8Array | null;
};
export declare function onEvent(ws: any, event: string, fn: (...args: any[]) => void): unknown;
/** A response body that is ALREADY valid JSON text. A gateway's restResources hands it
 *  over UNPARSED when the caller signalled it can take raw text (`ResourceRequest.raw`,
 *  set only by handleExec — the fetch arm, whose reply goes straight out); handleExec
 *  then ships the text in the frame's BINARY slot, so the reply's JSON header never
 *  re-serializes it either. That removes a full parse AND a full stringify of the body
 *  on the gateway — measured 83 ms + 122 ms on an 8.9 MB reply — for bytes the gateway
 *  never looks at. The receiving edge parses once, exactly as it already did when the
 *  body travelled inside the header.
 *
 *  Deliberately NOT used on the migrate arm or the hello preboot: there the envelope
 *  becomes continuation state or rides a JSON message, and a marker object would
 *  serialize as data instead of the body. The `raw` hint keeps those paths on the
 *  parsed path by simply not asking. Trade: malformed upstream JSON now surfaces at
 *  the receiving edge rather than in the gateway. */
export declare class RawJsonBody {
    readonly text: string;
    constructor(text: string);
}
export interface Port {
    send(obj: object, bin?: Uint8Array): void;
    onMessage(cb: (obj: any, bin: Uint8Array | null) => void): void;
    onClose(cb: () => void): void;
    close(): void;
}
export declare function wsPort(ws: any): Port;
interface ByteReader {
    read(): Promise<{
        value?: Uint8Array;
        done: boolean;
    }>;
}
interface ByteWriter {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
}
export declare function wtPort(stream: {
    readable: {
        getReader(): ByteReader;
    };
    writable: {
        getWriter(): ByteWriter;
    };
}): Port;
export declare function makePeer(port: Port): Peer;
