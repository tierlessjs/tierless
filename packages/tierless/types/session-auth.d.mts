import type { IncomingMessage, ServerResponse } from "node:http";
import type { Exec } from "./types.mjs";
export interface CookieAuthorityOpts {
    /** The backend the exec services crossings against (localhost, as deployed). */
    backendUrl: string;
    /** Page origins allowed to call reseal/claim — the same gate the ws upgrade uses.
     *  These endpoints trade credentials, so the CORS check IS the security boundary. */
    allowedOrigins: Iterable<string>;
    /** Claim-ticket lifetime; the ticket replays Set-Cookie, so it stays short. */
    claimTtlMs?: number;
    fetchImpl?: typeof fetch;
    /** GET paths to pre-fetch at the ws upgrade (boot preboot): the gateway fetches each with
     *  the upgrade's own cookie and hands the envelopes to the browser in the hello, so the
     *  boot data crosses DURING bundle download and the first crossings join it. Read-only,
     *  idempotent GETs only — never a mutation. */
    prebootPaths?: string[];
    /** Test seam. */
    now?: () => number;
}
/** Apply set-cookie lines to a cookie request-header string: name=value pairs win,
 *  Max-Age<=0 / a past Expires / an empty value deletes. Attributes beyond liveness
 *  are the browser jar's business (the claim replays the raw lines for that). */
export declare function mergeCookies(header: string, setCookies: string[]): string;
export declare function cookieAuthority({ backendUrl, allowedOrigins, claimTtlMs, fetchImpl, prebootPaths, now }: CookieAuthorityOpts): {
    exec: Exec;
    handleHttp(req: IncomingMessage, res: ServerResponse): boolean;
    hello(cookie: string, opts?: {
        auth?: boolean;
        preboot?: boolean;
    }): Promise<{
        blob: string | null;
        sealed: boolean;
        preboot?: Record<string, unknown>;
    }>;
};
