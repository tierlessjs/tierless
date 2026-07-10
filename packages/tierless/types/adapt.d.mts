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
export declare function restResources(baseUrl: string, { token, headers, fetchImpl, envelopeErrors }?: RestResourcesOpts): Exec;
