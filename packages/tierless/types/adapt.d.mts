import type { Exec } from "./types.mjs";
export interface RestResourcesOpts {
    /** Bearer token forwarded as Authorization (the end user's — from the session). */
    token?: string;
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
}
/** An Exec servicing `api.get(path)` / `api.post(path, body)` against a real REST base URL.
 *  Resolves to the response body (JSON-parsed when the response is JSON); non-2xx throws,
 *  unwinding into the workflow's own try/catch like any resource error. */
export declare function restResources(baseUrl: string, { token, headers, fetchImpl }?: RestResourcesOpts): Exec;
