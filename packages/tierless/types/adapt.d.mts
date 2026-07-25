import type { Exec, ResourceRequest } from "./types.mjs";
export interface TwinResponse {
    data: unknown;
    status: number;
    statusText: string;
    headers: Record<string, string>;
}
/** The server-side TWIN of an app's own axios instance: the same call surface
 *  (`get(url, config)`, `post(url, data, config)`, …) over fetch against the backend's
 *  local base URL, resolving to { data, status, headers, statusText } and rejecting
 *  AxiosError-shaped on non-2xx. Interim stand-in for building the twin from the app's
 *  OWN factory (which needs the pinned-global leases — ports/vikunja/COMPILING.md):
 *  the interceptors' observable effects (Content-Type, Authorization) are reproduced
 *  from the session's token. Params serialize axios-style (arrays as key[]). */
export declare function twinHttp(baseUrl: string, { token, headers, fetchImpl }?: {
    token?: string;
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
}): Record<string, unknown>;
export interface RestResourcesOpts {
    /** Bearer token forwarded as Authorization (the end user's — from the session). */
    token?: string;
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
    /** Resolve non-2xx to the envelope instead of throwing. Callers that speak HTTP
     *  semantics themselves (the axios adapter honors validateStatus) need status,
     *  headers, and error body intact. Default false: workflow code sees a throw. */
    envelopeErrors?: boolean;
    /** GATEWAY-SIDE: ask the upstream for `identity` instead of letting fetch negotiate
     *  gzip. The session socket deflates every reply anyway (permessage-deflate), so
     *  upstream compression is pure recompression: the backend gzips and the gateway
     *  immediately gunzips, burning CPU in BOTH processes to shrink a hop that is
     *  normally localhost or same-VPC. Measured on an 8.9 MB JSON reply: 46 ms backend
     *  gzip + 147 ms gateway gunzip, for bytes that never reach the browser in that
     *  form. The trade is real and stated: the upstream hop carries the full body
     *  uncompressed, so leave this OFF when the gateway is far from the backend.
     *  A caller's own accept-encoding header always wins. */
    upstreamIdentity?: boolean;
}
/** An Exec servicing `api.get(path)` / `api.post(path, body)` — and per-request headers
 *  via `api.get(path, undefined, {headers})` — against a real REST base URL.
 *  Resolves to an ENVELOPE { status, headers, body } — apps read semantics from custom
 *  response headers (pagination counts, permission levels), so they must migrate with the
 *  body. `headers` carries content-type and every x-* header. Non-2xx throws unless
 *  envelopeErrors. `path` may be a full URL only on the base's own origin — this exec
 *  must never become an open proxy. */
/** An Exec servicing `http.<method>` — the compiled form of a service's own
 *  `await this.http.get(...)` (instance-held resource, resources {"this.http":"server"}).
 *  `instance` is the tier's twin of the app's own axios instance: on the server, built
 *  by the app's OWN factory with the tierless axios adapter at the bottom, so the app's
 *  interceptors run there too. Resolves to the axios-response subset real service code
 *  reads: { data, status, headers, statusText } — plain data, wire-safe. AxiosError-
 *  shaped rejections cross as errors and unwind into the compiled code's own try/catch. */
/** The http family's DECLARED pins — requests whose axios config makes them browser-
 *  bound by MEANING, not by transport: a blob/stream response can't cross, progress
 *  callbacks act on live UI, cookie-jar auth and in-flight abort semantics exist only
 *  where the request was written. Serializable configs no ownership scan could flag.
 *  (Callbacks and FormData/Blob values are caught by the host's generic scan.) */
export declare function httpPins(req: ResourceRequest): boolean;
/** Prepare an http.* request for CROSSING: run the instance's own request-interceptor
 *  chain (app code — auth headers, model→DTO transforms, casing) right here, where it
 *  was written to run, and emit the post-chain wire config — exactly what axios would
 *  hand its adapter. A synchronous chain returns the crossing form directly; an async
 *  interceptor switches to a promise that AWAITS the chain once and continues from
 *  there — the already-invoked handler is never re-run (re-pinning to the instance
 *  would execute its side effects twice and orphan the first promise's rejection).
 *  Interceptors execute in axios's order (reverse registration); a chain error rejects
 *  like the request itself failing, exactly as stock axios rejects the request. */
export declare function crossHttpRequest(instance: {
    defaults?: {
        baseURL?: string;
        headers?: {
            common?: Record<string, unknown>;
        };
    };
    interceptors?: {
        request?: {
            forEach: (fn: (h: {
                fulfilled?: (c: unknown) => unknown;
                runWhen?: (c: unknown) => boolean;
            }) => void) => void;
        };
    };
} | null | undefined, req: ResourceRequest): ResourceRequest | null | Promise<ResourceRequest | null>;
export declare function httpResources(instance: Record<string, unknown>): Exec;
/** GATEWAY REQUEST COALESCING (nginx proxy_cache_lock / Varnish request coalescing).
 *  While an `api.get` for the same (path, principal) is in flight, later callers JOIN it
 *  instead of issuing their own — the one case a cache structurally cannot cover, because
 *  at the moment the duplicates are issued there is nothing cached yet.
 *
 *  Measured on n8n: three page sessions cold-fetch the same 12.4 MB endpoint within one
 *  response window, and the backend serving them concurrently takes 14-21 s EACH (~50 s
 *  in one 10-test spec) where a single uncontended fetch is ~200 ms.
 *
 *  `paths` is an ALLOW-LIST, not a switch, because the safety condition is per endpoint:
 *  the response must depend on the path and the credential ONLY. An endpoint that varies
 *  on some other request header (a real `Vary:`) must never be coalesced, and joiners are
 *  chosen before any response exists, so Vary cannot be honored after the fact. Naming the
 *  endpoints keeps that judgement explicit and auditable per deployment — the same shape
 *  as the gateway's preboot path list. Query strings distinguish resources, so matching is
 *  on the path before `?` while the join key keeps the full path.
 *
 *  Each joiner gets its OWN shallow copy of the envelope, so per-session mutation (the
 *  cookie-authority rotation field) stays private. Wrap the exec that sees the RESOLVED
 *  credential (inside cookieAuthority, not above it: a sealed blob is re-randomized per
 *  session and would never match). */
export declare function coalesceGets(inner: Exec, paths: Iterable<string>): Exec;
export declare function restResources(baseUrl: string, { token, headers, fetchImpl, envelopeErrors, upstreamIdentity }?: RestResourcesOpts): Exec;
