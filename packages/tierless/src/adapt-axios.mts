// The tierless axios adapter — the I/O-bottom cut for axios apps (docs/corpus.md).
//
// Axios's lowest layer is a pluggable slot: `adapter(config) -> Promise<AxiosResponse>`
// (the stock ones are XHR in browsers, node:http in Node). This adapter fulfills that
// contract by issuing a tierless RESOURCE REQUEST instead of performing host I/O. The
// app's code — services, interceptors, models — is untouched and axios's upper layers
// run as always; only the mechanism under them changes. A resource request is
// serializable (a legal continuation cut point), authority-carrying (the app's own
// interceptor attached Authorization before we see the config), and priceable (§6).
//
// Who executes the request depends on where the calling code is: browser code gets a
// direct-fetch exec (stock behavior, byte for byte); a migrated continuation's requests
// execute against the gateway's localhost exec. This module knows nothing about routes
// or pages — it is mechanism only.
//
// Browser-pinned configs — progress callbacks, blob/stream responses — are intrinsic
// browser behavior, not transportable I/O: they fall through to `fallback` (axios's own
// default adapter), and placement must not migrate across them.
import type { Exec } from "./types.mjs";

/** The subset of an axios config the adapter reads (structurally — no axios dependency). */
export interface AxiosishConfig {
  method?: string;
  url?: string;
  baseURL?: string;
  params?: Record<string, unknown>;
  paramsSerializer?: { serialize?: (p: Record<string, unknown>) => string } | ((p: Record<string, unknown>) => string);
  data?: unknown;
  headers?: Record<string, unknown> & { toJSON?: () => Record<string, unknown> };
  responseType?: string;
  validateStatus?: ((status: number) => boolean) | null;
  onUploadProgress?: unknown;
  onDownloadProgress?: unknown;
  [key: string]: unknown;
}

export interface AxiosAdapterOpts {
  /** Fulfills api.* resource requests. Browser: restResources(origin) over fetch. */
  exec: Exec;
  /** Axios's own adapter, for browser-pinned configs (progress, blob). */
  fallback?: (config: AxiosishConfig) => Promise<unknown>;
}

/** axios-compatible default param serialization: null/undefined skipped, arrays as
 *  repeated `key[]`, Dates as ISO strings. Standard percent-encoding (the backend
 *  parses url-encoding; axios's cosmetic un-escaping of [,] etc. is not semantic). */
export function serializeParams(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    const one = (x: unknown): string => (x instanceof Date ? x.toISOString() : typeof x === "object" ? JSON.stringify(x) : String(x));
    if (Array.isArray(v)) for (const item of v) q.append(k + "[]", one(item));
    else q.append(k, one(v));
  }
  return q.toString();
}

const pinned = (c: AxiosishConfig): boolean =>
  !!(c.onUploadProgress || c.onDownloadProgress || c.responseType === "blob" || c.responseType === "stream" || c.responseType === "arraybuffer"
    || (typeof FormData !== "undefined" && c.data instanceof FormData)
    || (typeof Blob !== "undefined" && c.data instanceof Blob));

export function axiosAdapter({ exec, fallback }: AxiosAdapterOpts) {
  return async function tierlessAxiosAdapter(config: AxiosishConfig): Promise<unknown> {
    if (pinned(config)) {
      if (!fallback) throw new Error("tierless axios adapter: browser-pinned config (progress/blob) needs a fallback adapter");
      return fallback(config);
    }

    const method = (config.method || "get").toLowerCase();
    // Full URL from baseURL + url, exactly as axios would combine them; params appended
    // with the config's own serializer when present.
    const base = config.baseURL ? new URL(config.baseURL, typeof location !== "undefined" ? location.href : undefined) : undefined;
    const baseOrigin = base ? base.origin : (typeof location !== "undefined" ? location.origin : "http://localhost");
    const joined = config.url && /^https?:\/\//.test(config.url)
      ? new URL(config.url)
      : new URL((base ? base.pathname.replace(/\/$/, "") : "") + "/" + String(config.url || "").replace(/^\//, ""), baseOrigin);
    // only the app's OWN api crosses as a resource request; an explicit other-origin URL
    // is external I/O — stock behavior via the fallback, never a tier crossing
    if (joined.origin !== baseOrigin) {
      if (!fallback) throw new Error("tierless axios adapter: cross-origin request needs a fallback adapter: " + joined.origin);
      return fallback(config);
    }
    let path = joined.pathname + joined.search;
    if (config.params && Object.keys(config.params).length) {
      const s = typeof config.paramsSerializer === "function" ? config.paramsSerializer(config.params)
        : config.paramsSerializer?.serialize ? config.paramsSerializer.serialize(config.params)
        : serializeParams(config.params);
      if (s) path += (joined.search ? "&" : "?") + s;
    }

    const rawHeaders = config.headers?.toJSON ? config.headers.toJSON() : { ...(config.headers || {}) };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) if (v !== undefined && v !== null && typeof v !== "function") headers[k.toLowerCase()] = String(v);

    // ORIGIN-RELATIVE on purpose: the api namespace is tier-owned — whoever executes the
    // request binds it to ITS OWN base (browser: restResources(origin); a session
    // gateway: its localhost backend). An absolute URL would weld the browser's origin
    // spelling (hostname, counting-relay port) into a request another tier executes.
    const envelope = await exec({
      op: "resource", tier: "server", name: "api." + method,
      args: [path, config.data === undefined ? undefined : config.data, { headers }],
    }) as { status: number; headers: Record<string, string>; body: unknown };

    const response = {
      data: envelope.body,
      status: envelope.status,
      statusText: "",
      headers: envelope.headers,
      config,
      request: {},
    };
    const validate = config.validateStatus === undefined ? (s: number) => s >= 200 && s < 300 : config.validateStatus;
    if (validate && !validate(envelope.status)) {
      // shaped like AxiosError without depending on axios: their code reads .response/.isAxiosError
      const err = new Error("Request failed with status code " + envelope.status) as Error & { response: unknown; config: unknown; isAxiosError: boolean; code: string };
      err.response = response; err.config = config; err.isAxiosError = true;
      err.code = envelope.status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST";
      throw err;
    }
    return response;
  };
}
