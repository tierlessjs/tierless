import type { Exec } from "./types.mjs";
/** The subset of an axios config the adapter reads (structurally — no axios dependency). */
export interface AxiosishConfig {
    method?: string;
    url?: string;
    baseURL?: string;
    params?: Record<string, unknown>;
    paramsSerializer?: {
        serialize?: (p: Record<string, unknown>) => string;
    } | ((p: Record<string, unknown>) => string);
    data?: unknown;
    headers?: Record<string, unknown> & {
        toJSON?: () => Record<string, unknown>;
    };
    responseType?: string;
    validateStatus?: ((status: number) => boolean) | null;
    onUploadProgress?: unknown;
    onDownloadProgress?: unknown;
    withCredentials?: boolean;
    timeout?: number;
    signal?: unknown;
    cancelToken?: unknown;
    [key: string]: unknown;
}
export interface AxiosAdapterOpts {
    /** Fulfills api.* resource requests. Browser: restResources(origin) over fetch. */
    exec: Exec;
    /** Axios's own adapter, for browser-pinned configs (progress, blob). */
    fallback?: (config: AxiosishConfig) => Promise<unknown>;
}
/** axios-compatible default param serialization, the recursive visitor semantics:
 *  null/undefined/functions skipped (inside arrays too), arrays as repeated `key[]`,
 *  nested objects as bracketed keys (`filter[status]`), Dates as ISO strings. Standard
 *  percent-encoding (the backend parses url-encoding; axios's cosmetic un-escaping of
 *  [,] etc. is not semantic). */
export declare function serializeParams(params: Record<string, unknown>): string;
export declare function axiosAdapter({ exec, fallback }: AxiosAdapterOpts): (config: AxiosishConfig) => Promise<unknown>;
