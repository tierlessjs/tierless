import type { Exec } from "./types.mjs";
/** The header a crossing carries the sealed blob in; the gateway strips it before the
 *  backend ever sees the request. Shared constant with session-auth.mts (gateway side). */
export declare const SESSION_AUTH_HEADER = "x-tierless-session-auth";
/** The rotation annotation key on an exec envelope. Stripped here before the app sees it. */
export declare const AUTH_FIELD = "__tierlessAuth";
/** What the gateway delivers in the ws "hello" the instant the socket is up (server side:
 *  session-auth.mts cookieAuthority.hello, wired through attachTierless). `blob` folds the
 *  reseal round trip INTO the upgrade — the gateway seals the upgrade's own cookie and hands
 *  it back, so no startup HTTP reseal is needed. `preboot` is a map of GET path -> envelope
 *  the gateway pre-fetched at upgrade (docs boot preboot): the first crossings JOIN it. */
export interface SessionHello {
    blob: string | null;
    preboot?: Record<string, unknown> | null;
}
export interface CookieSessionAuthOpts {
    /** The gateway's http(s) origin, e.g. `http://localhost:5780`. */
    gateway: string;
    /** BroadcastChannel name for cross-tab rotation. Tabs sharing a jar must share it. */
    channelName?: string;
    fetchImpl?: typeof fetch;
    /** The session socket's "hello" (adapt-session-auth SessionHello). When present, the
     *  startup blob comes from it — no HTTP reseal round trip on the critical path — and its
     *  preboot map seeds the join buffer. Absent = the pre-hello behavior: HTTP reseal at
     *  startup. Rotation/401 recovery still uses the HTTP reseal endpoint either way. */
    hello?: Promise<SessionHello>;
}
export declare function cookieSessionAuth({ gateway, channelName, fetchImpl, hello }: CookieSessionAuthOpts): {
    wrap(inner: Exec): Exec;
};
