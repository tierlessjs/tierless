import { type AxiosishConfig } from "./adapt-axios.mjs";
import type { Exec } from "./types.mjs";
export interface AutoSessionOpts {
    /** Explicit ws URL (overrides the page-derived convention; the localStorage override
     *  still wins — shaped runs must be routable without a rebuild). */
    url?: string;
    /** Gateway port for the page-derived URL. Default: page port + 100. */
    gatewayPort?: number;
    /** ws path on the gateway. Default: /__tierless. */
    path?: string;
    /** localStorage key a measured run sets to reroute the socket. null disables. */
    storageKey?: string | null;
    /** Static force-browser patterns (merged with window.__tierlessForceBrowser). */
    forceBrowser?: (string | RegExp)[];
    /** "auto" (default): cookie-auth wrap engaged by the gateway's own hello declaration.
     *  "none": bare session exec (authority rides in each request's own headers). */
    auth?: "auto" | "none";
    /** Which origins CROSS the session socket. Default: the page origin only. An app
     *  whose own API is served from another origin (NocoDB's test rig: UI on :3000, API
     *  on :8080) widens it — e.g. `cross: () => true` when the adapted client only ever
     *  talks to the app's own backend. Non-crossing origins get a direct browser fetch. */
    cross?: (origin: string) => boolean;
    /** cookieSessionAuth's awaitClaims (rotation jar-write ordering — see its doc). */
    awaitClaims?: boolean;
    /** Open the socket now so the upgrade handshake never lands on an interaction's
     *  critical path. Default true. */
    preconnect?: boolean;
    /** Conditional crossings (adapt-cache.mts): ETag'd GETs revalidate with
     *  If-None-Match instead of re-crossing in full — the browser cache's own
     *  semantics on the socket. Default true; false is the measurement ablation. */
    conditional?: boolean;
}
export interface AutoSession {
    /** The exec for the page's own origin (session socket + force-browser fallthrough). */
    exec: Exec;
    /** The exec for a request base: the page origin crosses the session socket, an
     *  external origin gets a direct browser fetch. Memoized per origin. */
    execFor(baseUrl?: string): Exec;
    /** The ws URL in effect (after overrides) — the gateway origin derives from it. */
    wsUrl: string;
}
export declare function autoSession({ url, gatewayPort, path, storageKey, forceBrowser, auth, cross, awaitClaims, preconnect, conditional }?: AutoSessionOpts): AutoSession;
interface AxiosModuleLike {
    getAdapter?: (names: unknown) => (config: AxiosishConfig) => Promise<unknown>;
}
interface AxiosInstanceLike {
    defaults: {
        adapter?: unknown;
        baseURL?: string;
    };
}
/** The whole transport port for an axios app, one call at the app's own API client:
 *
 *     import { tierlessAxios } from 'tierless/adapt-auto'
 *     tierlessAxios(axios, api.instance)
 *
 *  Installs the tierless I/O bottom (adapt-axios) fed by autoSession() — every request
 *  through this instance crosses the session socket (the INSTALLATION CONTRACT in
 *  adapt-axios.mts: the instance's baseURL IS the app's own API, wherever it is hosted;
 *  explicit other-origin URLs still fall through at the adapter). Browser-pinned
 *  configs fall through to the app's own stock adapter via `axios.getAdapter`. Under
 *  SSR/Node this is a no-op — the stock adapter stays. Idempotent per instance; the
 *  first call's opts configure the shared session (one socket per page). */
export declare function tierlessAxios(axios: AxiosModuleLike, instance: AxiosInstanceLike, opts?: AutoSessionOpts): void;
export {};
