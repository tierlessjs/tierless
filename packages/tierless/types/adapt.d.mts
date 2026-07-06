import type { Exec } from "./types.mjs";
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
export declare function restResources(baseUrl: string, { token, headers, fetchImpl, envelopeErrors }?: RestResourcesOpts): Exec;
