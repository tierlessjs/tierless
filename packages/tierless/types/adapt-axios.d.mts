import type { Exec } from "./types.mjs";
/** The subset of an axios config the adapter reads (structurally — no axios dependency). */
export interface AxiosishConfig {
    method?: string;
    url?: string;
    baseURL?: string;
    params?: Record<string, unknown> | URLSearchParams;
    paramsSerializer?: {
        serialize?: (p: any) => string;
    } | ((p: any) => string);
    data?: unknown;
    headers?: Record<string, unknown> & {
        toJSON?: () => Record<string, unknown>;
    };
    responseType?: string;
    validateStatus?: ((status: number) => boolean) | null;
    onUploadProgress?: unknown;
    onDownloadProgress?: unknown;
    withCredentials?: boolean;
    withXSRFToken?: boolean | ((config: AxiosishConfig) => boolean);
    xsrfCookieName?: string;
    xsrfHeaderName?: string;
    timeout?: number;
    signal?: unknown;
    cancelToken?: unknown;
    auth?: {
        username?: string;
        password?: string;
    };
    [key: string]: unknown;
}
export interface AxiosAdapterOpts {
    /** Fulfills api.* resource requests. Browser: restResources(origin) over fetch. */
    exec: Exec;
    /** Axios's own adapter, for browser-pinned configs (progress, blob). */
    fallback?: (config: AxiosishConfig) => Promise<unknown>;
    /** Cross requests marked `withCredentials` instead of pinning them to the browser.
     *  ONLY valid behind a `--cookie-authority` gateway, which holds the upgrade's cookie
     *  and replays it upstream — that is what makes the jar reproducible on the other
     *  tier. Off by default: without an authority a crossed credentialed request silently
     *  loses its cookies and the app sees 401/403.
     *
     *  Needed by any cookie-auth app that sets the flag globally: InvenTree's
     *  `api.defaults.withCredentials = true` pinned 100% of its traffic, so the port
     *  would have measured a session that carried nothing. */
    crossCredentialed?: boolean;
    /** Cross requests that carry a `timeout` instead of pinning them, enforcing the
     *  deadline here (the caller gets axios's own ECONNABORTED shape). Off by default
     *  because the semantics are NOT identical: XHR aborts the request, while a crossing
     *  that misses its deadline is abandoned by the caller and still completes upstream.
     *  For an app whose api client sets a blanket default timeout — InvenTree sets
     *  5000 ms — pinning on it would exclude every request. */
    crossTimeouts?: boolean;
}
/** axios-compatible default param serialization, the recursive visitor semantics:
 *  null/undefined/functions skipped (inside arrays too), arrays as repeated `key[]`,
 *  nested objects as bracketed keys (`filter[status]`), Dates as ISO strings. Standard
 *  percent-encoding (the backend parses url-encoding; axios's cosmetic un-escaping of
 *  [,] etc. is not semantic). */
export declare function serializeParams(params: Record<string, unknown>): string;
export declare function axiosAdapter({ exec, fallback, crossCredentialed, crossTimeouts }: AxiosAdapterOpts): (config: AxiosishConfig) => Promise<unknown>;
