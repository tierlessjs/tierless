import type { Exec } from "./types.mjs";
/** The header a crossing carries the sealed blob in; the gateway strips it before the
 *  backend ever sees the request. Shared constant with session-auth.mts (gateway side). */
export declare const SESSION_AUTH_HEADER = "x-tierless-session-auth";
/** The rotation annotation key on an exec envelope. Stripped here before the app sees it. */
export declare const AUTH_FIELD = "__tierlessAuth";
export interface CookieSessionAuthOpts {
    /** The gateway's http(s) origin, e.g. `http://localhost:5780`. */
    gateway: string;
    /** BroadcastChannel name for cross-tab rotation. Tabs sharing a jar must share it. */
    channelName?: string;
    fetchImpl?: typeof fetch;
}
export declare function cookieSessionAuth({ gateway, channelName, fetchImpl }: CookieSessionAuthOpts): {
    wrap(inner: Exec): Exec;
};
