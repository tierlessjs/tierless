import type { Peer } from "./types.mjs";
export type { Peer } from "./types.mjs";
export declare const PROTOCOL_VERSION = 2;
/** magic+version, jsonLen, binLen — every reader of the raw frame uses this. */
export declare const HEADER_BYTES = 12;
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
/** The original JSON text of a body that crossed in the binary slot, hung off the
 *  reassembled envelope under a symbol key: invisible to app code, ignored by
 *  JSON.stringify, and free — the receiving edge already holds it. It exists so a cache
 *  can persist the envelope WITHOUT re-serializing a body it was just handed as bytes,
 *  which is what let the envelope store become a cheap, synchronous write instead of a
 *  deferred one that lost races to page navigation (adapt-cache.mts). */
export declare const RAW_TEXT: unique symbol;
/** Marks a ResourceRequest as a WIRE-LAYER request another layer will re-present: the
 *  exec log (pushExecLog) skips it, and the presenting layer logs the app-visible
 *  crossing itself. Exists because harness waits consume log entries EXACTLY ONCE
 *  (playwright.mts firstCrossing advances a cursor), so an entry that is wrong when
 *  pushed cannot be fixed up later — a revalidating 304 logged at the wire layer was
 *  judged by status-checking waits before the cache wrap could replace it with the 200
 *  the app actually received. The wrong entry must never be pushed at all. */
export declare const SKIP_EXEC_LOG: unique symbol;
/** THE exec-log entry writer — the one owner of the entry shape (browser.mts logs the
 *  plain session path through it; adapt-cache logs re-presented conditional crossings).
 *  The log is the harness-waits contract (tierless/playwright): entries must show what
 *  STOCK fetch would have shown the page, which is why a marked wire request is skipped
 *  rather than logged as-is. */
export declare function pushExecLog(req: {
    name?: unknown;
    args?: unknown[];
} & {
    [SKIP_EXEC_LOG]?: boolean;
}, status: number | undefined, body: unknown, hasBody: boolean, headers?: Record<string, string>): void;
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
