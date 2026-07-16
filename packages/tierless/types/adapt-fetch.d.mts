import type { Exec } from "./types.mjs";
export interface FetchAdapterOpts {
    /** Services crossable requests — `sessionExec()` (or an autoSession execFor). */
    exec: Exec;
    /** The app's API origin; requests to other origins fall through. Default: the page
     *  origin. A function is read per request (apps that discover their backend late). */
    origin?: string | (() => string);
    /** App-specific browser-pins: return true to keep a request on the host fetch. */
    pins?: (url: URL, init: RequestInit) => boolean;
    /** Override the whole crossability decision: true/false forces, undefined applies
     *  the default policy above. */
    crossable?: (url: URL, init: RequestInit) => boolean | undefined;
    /** The fallthrough fetch (default: the host's). */
    fetchImpl?: typeof fetch;
}
export declare function fetchAdapter({ exec, origin, pins, crossable, fetchImpl }: FetchAdapterOpts): (input: string | URL, init?: RequestInit) => Promise<Response>;
