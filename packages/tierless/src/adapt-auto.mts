// One-call session wiring for a corpus port — the browser side of the port recipe,
// generalized out of the per-port session-socket patches (each port re-derived the ws
// URL, the shaped-run override, preconnect, the same-origin/external split, the
// force-browser seam, and the cookie-auth wrap by hand — ~60 lines per app of pure
// convention). With this, an I/O-bottom patch is the seam line plus:
//
//   const tierless = autoSession();                       // or { gatewayPort, forceBrowser, ... }
//   axiosInstance.defaults.adapter = axiosAdapter({ exec: tierless.execFor(baseURL), ... });
//
// Conventions (each overridable):
//   - ws URL: `ws(s)://<page-hostname>:<page-port + 100>/__tierless`, scheme following
//     the page (an https page blocks ws:// as mixed content); explicit `url` or
//     `gatewayPort` override; a `tierlessWsUrl` localStorage key overrides everything —
//     the measured-run hook that routes the socket through a shaping relay.
//   - same-origin requests cross the session socket; an external origin keeps a direct
//     browser fetch (stock behavior — external I/O is never a crossing).
//   - force-browser: a request matching `forceBrowser` globs — or the page-global
//     `window.__tierlessForceBrowser` a test harness populates (tierless/playwright's
//     recordForceBrowserRoutes) — stays on the browser's own fetch, visible to service
//     workers, extensions, and route interception. Empty in production: a no-op.
//   - cookie authority: auth "auto" (default) wraps the exec in cookieSessionAuth and
//     lets the GATEWAY's hello declaration decide — a sealing gateway delivers the blob
//     in the ws upgrade, a header-auth gateway declares sealed:false and the wrap
//     no-ops. Costs header-auth apps nothing (attachTierless always sends a hello).
import { configureTierless, sessionExec, sessionHello } from "./browser.mjs";
import { cookieSessionAuth } from "./adapt-session-auth.mjs";
import { restResources } from "./adapt.mjs";
import { axiosAdapter, type AxiosishConfig } from "./adapt-axios.mjs";
import { WS_PATH } from "./ws-path.mjs";
import { matchesForceBrowser, type ForceBrowserDescriptor } from "./url-glob.mjs";
import type { Exec, ResourceRequest } from "./types.mjs";

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

export function autoSession({ url, gatewayPort, path = WS_PATH, storageKey = "tierlessWsUrl", forceBrowser = [], auth = "auto", cross, awaitClaims, preconnect = true }: AutoSessionOpts = {}): AutoSession {
  if (typeof location === "undefined") throw new Error("autoSession: browser-only (SSR/twin bundles keep their host fetch — gate the call on typeof location)");
  const pagePort = Number(location.port || (location.protocol === "https:" ? 443 : 80));
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const derived = url || `${scheme}://${location.hostname}:${gatewayPort ?? pagePort + 100}${path}`;
  const override = storageKey === null ? null : (() => { try { return localStorage.getItem(storageKey); } catch { return null; } })();
  const wsUrl = override || derived;
  configureTierless({ url: wsUrl, preconnect });

  const staticList: ForceBrowserDescriptor[] = forceBrowser.map((p) => (typeof p === "string" ? { glob: p } : { re: [p.source, p.flags] }));
  const pageList = (): ForceBrowserDescriptor[] => (window as { __tierlessForceBrowser?: ForceBrowserDescriptor[] }).__tierlessForceBrowser ?? [];
  const forced = (req: ResourceRequest, origin: string): boolean => {
    const list = [...staticList, ...pageList()];
    if (!list.length) return false;
    const path0 = String((req.args ?? [])[0] ?? "");
    let full: string;
    try { full = new URL(path0, origin + "/").href; } catch { full = origin + path0; }
    return matchesForceBrowser(list, full);
  };

  const session: Exec = auth === "none"
    ? sessionExec()
    : cookieSessionAuth({ gateway: new URL(wsUrl.replace(/^ws/, "http")).origin, hello: sessionHello(), ...(awaitClaims !== undefined ? { awaitClaims } : {}) }).wrap(sessionExec());

  const crosses = cross ?? ((origin: string) => origin === location.origin);
  const byOrigin = new Map<string, Exec>();
  const execFor = (baseUrl = "/"): Exec => {
    const origin = new URL(baseUrl, location.href).origin;
    let e = byOrigin.get(origin);
    if (!e) {
      const direct = restResources(origin, { envelopeErrors: true });
      e = crosses(origin) ? (req) => (forced(req, origin) ? direct(req) : session(req)) : direct;
      byOrigin.set(origin, e);
    }
    return e;
  };

  return { exec: execFor(), execFor, wsUrl };
}

// ------------------------------------------------------------- the 2-line port ----
// Structural slices of axios — no axios dependency; the app hands its own module in
// (it is also where the stock XHR fallback for browser-pinned configs comes from).
interface AxiosModuleLike { getAdapter?: (names: unknown) => (config: AxiosishConfig) => Promise<unknown> }
interface AxiosInstanceLike { defaults: { adapter?: unknown; baseURL?: string } }

let sharedAuto: AutoSession | undefined;
const INSTALLED = new WeakSet<object>();

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
export function tierlessAxios(axios: AxiosModuleLike, instance: AxiosInstanceLike, opts: AutoSessionOpts = {}): void {
  if (typeof window === "undefined" || typeof location === "undefined") return;
  if (INSTALLED.has(instance)) return;
  INSTALLED.add(instance);
  sharedAuto ??= autoSession({ ...opts, cross: () => true });
  instance.defaults.adapter = axiosAdapter({
    exec: sharedAuto.execFor(instance.defaults.baseURL || "/"),
    fallback: typeof XMLHttpRequest !== "undefined" && axios.getAdapter ? axios.getAdapter(["xhr", "http"]) : undefined,
  });
}
