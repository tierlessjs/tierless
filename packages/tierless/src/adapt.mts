// Adapting EXISTING apps — the corpus program's rung 3 (docs/corpus.md).
//
// An existing app's backend is never rewritten: its REST endpoints become the resource
// space directly. A workflow module calls paths, not schema entries —
//
//   "use tierless";
//   export function openProject(id, view) {
//     const user = api.get("/user");
//     const project = api.get("/projects/" + id);
//     const tasks = api.get("/projects/" + id + "/views/" + view + "/tasks?...");
//     return { "/user": user, ["/projects/" + id]: project, ... };
//   }
//
// — and restResources() is the server-side exec that services api.get/api.post by
// calling the real backend over localhost, forwarding the end user's bearer token. The
// gateway holds NO authority of its own: every request is authorized by the backend
// exactly as if the browser had sent it. (The reference-monitor api service remains the
// trust model for apps that own their backend; this adapter is the no-rewrite seam.)
import { serializeParams } from "./adapt-axios.mjs";
import type { Exec, ResourceRequest } from "./types.mjs";

// What twinHttp's methods resolve to / reject with — the axios-response subset real
// service code reads, and the AxiosError shape their catch blocks inspect.
export interface TwinResponse { data: unknown; status: number; statusText: string; headers: Record<string, string> }

/** The server-side TWIN of an app's own axios instance: the same call surface
 *  (`get(url, config)`, `post(url, data, config)`, …) over fetch against the backend's
 *  local base URL, resolving to { data, status, headers, statusText } and rejecting
 *  AxiosError-shaped on non-2xx. Interim stand-in for building the twin from the app's
 *  OWN factory (which needs the pinned-global leases — ports/vikunja/COMPILING.md):
 *  the interceptors' observable effects (Content-Type, Authorization) are reproduced
 *  from the session's token. Params serialize axios-style (arrays as key[]). */
export function twinHttp(baseUrl: string, { token, headers = {}, fetchImpl = fetch }: { token?: string; headers?: Record<string, string>; fetchImpl?: typeof fetch } = {}): Record<string, unknown> {
  const base = baseUrl.replace(/\/$/, "");
  const call = async (method: string, url: string, data: unknown, config: { params?: Record<string, unknown>; headers?: Record<string, string> } = {}): Promise<TwinResponse> => {
    // absolute URLs (the browser-side instance's baseURL applied by bindMethods) are
    // RE-HOMED: path + query onto the twin's own base — the gateway reaches the same
    // backend under its local address, whatever origin the page used
    if (/^https?:\/\//.test(url)) { const u = new URL(url); url = u.pathname + u.search; }
    let path = url.startsWith("/") ? base + url : url;
    if (config.params && Object.keys(config.params).length) path += (path.includes("?") ? "&" : "?") + serializeParams(config.params);
    const r = await fetchImpl(path, {
      method: method.toUpperCase(),
      headers: {
        ...(data !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: token.startsWith("Bearer ") ? token : "Bearer " + token } : {}),
        ...headers,
        ...(config.headers || {}),
      },
      ...(data !== undefined ? { body: typeof data === "string" ? data : JSON.stringify(data) } : {}),
    });
    const text = await r.text();
    const isJson = (r.headers.get("content-type") || "").includes("json");
    const hdrs: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (k === "content-type" || k.startsWith("x-")) hdrs[k] = v; });   // all the app reads (pagination, permissions) — date/vary/server would be dead wire weight
    const res: TwinResponse = { data: isJson && text ? JSON.parse(text) : text, status: r.status, statusText: r.statusText, headers: hdrs };
    if (r.status < 200 || r.status >= 300) {
      const err = new Error("Request failed with status code " + r.status) as Error & { response: TwinResponse; isAxiosError: boolean; code: string };
      err.response = res; err.isAxiosError = true; err.code = r.status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST";
      throw err;
    }
    return res;
  };
  return {
    get: (url: string, c?: object) => call("get", url, undefined, c),
    delete: (url: string, c?: object) => call("delete", url, undefined, c),
    head: (url: string, c?: object) => call("head", url, undefined, c),
    options: (url: string, c?: object) => call("options", url, undefined, c),
    post: (url: string, data?: unknown, c?: object) => call("post", url, data, c),
    put: (url: string, data?: unknown, c?: object) => call("put", url, data, c),
    patch: (url: string, data?: unknown, c?: object) => call("patch", url, data, c),
  };
}

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
export function httpPins(req: ResourceRequest): boolean {
  const KEYS = ["responseType", "onUploadProgress", "onDownloadProgress", "withCredentials", "signal", "cancelToken", "timeout"];
  const cfg = req.args.find((a) => a !== null && typeof a === "object" && KEYS.some((k) => k in (a as object))) as
    { responseType?: string; withCredentials?: boolean; signal?: unknown; cancelToken?: unknown; timeout?: number } | undefined;
  if (!cfg) return false;
  const rt = cfg.responseType;
  // aligned with adapt-axios's pinned(): text must return the RAW string (the crossing
  // parses by content-type), document is browser-only decoding
  return rt === "blob" || rt === "stream" || rt === "arraybuffer" || rt === "text" || rt === "document"
    || !!cfg.withCredentials || !!cfg.signal || !!cfg.cancelToken || (typeof cfg.timeout === "number" && cfg.timeout > 0);
}

/** Prepare an http.* request for CROSSING: run the instance's own request-interceptor
 *  chain (app code — auth headers, model→DTO transforms, casing) right here, where it
 *  was written to run, and emit the post-chain wire config — exactly what axios would
 *  hand its adapter. A synchronous chain returns the crossing form directly; an async
 *  interceptor switches to a promise that AWAITS the chain once and continues from
 *  there — the already-invoked handler is never re-run (re-pinning to the instance
 *  would execute its side effects twice and orphan the first promise's rejection).
 *  Interceptors execute in axios's order (reverse registration); a chain error rejects
 *  like the request itself failing, exactly as stock axios rejects the request. */
export function crossHttpRequest(instance: { defaults?: { baseURL?: string; headers?: { common?: Record<string, unknown> } }; interceptors?: { request?: { forEach: (fn: (h: { fulfilled?: (c: unknown) => unknown; runWhen?: (c: unknown) => boolean }) => void) => void } } } | null | undefined, req: ResourceRequest): ResourceRequest | null | Promise<ResourceRequest | null> {
  const m = /^http\.(get|post|put|patch|delete|head|options)$/.exec(req.name);
  if (!m) return req;
  const verb = m[1];
  const hasBody = verb === "post" || verb === "put" || verb === "patch";
  const [url, a1, a2] = req.args as [string, unknown?, unknown?];
  const extra = (hasBody ? a2 : a1) as Record<string, unknown> | undefined;
  // a CUSTOM paramsSerializer (per-request or instance default) would be bypassed by the
  // crossing's own serialization — those requests run on the instance, where axios
  // applies it. (Default transformRequest is reproduced by wireJson; a custom transform
  // chain is app code the fallback runs faithfully too — it pins via the same rule when
  // it needs a serializer; other custom transforms are a documented divergence.)
  if (extra?.paramsSerializer || (instance?.defaults as { paramsSerializer?: unknown } | undefined)?.paramsSerializer) return null;
  const dfltHeaders = instance?.defaults?.headers as (Record<string, unknown> & { common?: Record<string, unknown> }) | undefined;
  let config: Record<string, unknown> = {
    method: verb, url,
    baseURL: instance?.defaults?.baseURL,
    ...(hasBody ? { data: a1 } : {}),
    ...(extra || {}),
    // axios precedence: common < method-specific defaults < per-request (the plain
    // spread above would have REPLACED the merged defaults with the per-request object)
    headers: {
      ...(dfltHeaders?.common || {}),
      ...((dfltHeaders?.[verb] as Record<string, unknown> | undefined) || {}),
      ...((extra?.headers as Record<string, unknown> | undefined) || {}),
    },
  };
  const finish = (c: Record<string, unknown>): ResourceRequest | null => {
    const cUrl = String(c.url || url);
    // an EXPLICIT other-origin URL is external I/O — it runs on the instance (stock
    // fetch semantics: this tier's cookies, IP, CORS), never as a tier crossing
    if (/^(https?:)?\/\//.test(cUrl)) {
      const bo = c.baseURL && /^https?:\/\//.test(String(c.baseURL)) ? new URL(String(c.baseURL)).origin : null;
      if (!bo || new URL(cUrl, bo).origin !== bo) return null;
    }
    // axios's combineURLs: trailing slashes off the base, leading off the path, ONE
    // slash between ("https://h/api" + "tasks" must not become "https://h/apitasks")
    const abs = /^https?:\/\//.test(cUrl) ? cUrl
      : c.baseURL ? String(c.baseURL).replace(/\/+$/, "") + "/" + cUrl.replace(/^\/+/, "") : cUrl;
    const rawHeaders = (c.headers as { toJSON?: () => Record<string, unknown> })?.toJSON ? (c.headers as { toJSON: () => Record<string, unknown> }).toJSON() : { ...(c.headers as Record<string, unknown> || {}) };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) if (v !== undefined && v !== null && typeof v !== "function" && typeof v !== "object") headers[k.toLowerCase()] = String(v);
    const cfg: Record<string, unknown> = { headers };
    if (c.params) cfg.params = wireJson(c.params);
    return { ...req, args: hasBody ? [abs, wireJson(c.data), cfg] : [abs, cfg] };
  };
  const handlers: Array<{ fulfilled?: (c: unknown) => unknown; runWhen?: (c: unknown) => boolean }> = [];
  instance?.interceptors?.request?.forEach((h) => handlers.push(h));
  handlers.reverse();                                              // axios runs request interceptors LIFO
  for (let i = 0; i < handlers.length; i++) {
    const h = handlers[i];
    if (h.runWhen && !h.runWhen(config)) continue;
    const r = h.fulfilled ? h.fulfilled(config) : config;
    if (r && typeof (r as { then?: unknown }).then === "function") {
      return (async () => {
        let c = ((await r) as Record<string, unknown>) || config;
        for (let j = i + 1; j < handlers.length; j++) {
          const g = handlers[j];
          if (g.runWhen && !g.runWhen(c)) continue;
          c = ((g.fulfilled ? ((await g.fulfilled(c)) as Record<string, unknown>) : c)) || c;
        }
        return finish(c);
      })();
    }
    config = (r as Record<string, unknown>) || config;
  }
  return finish(config);
}

// What crosses is EXACTLY axios's JSON pass: toJSON honored (models serialize
// themselves), Dates -> ISO strings, undefined and functions dropped — the wire body
// is byte-identical to what the stock adapter would have sent. Never applied to
// pinned requests (FormData/Blob run locally and never reach here).
const wireJson = (v: unknown): unknown => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

export function httpResources(instance: Record<string, unknown>): Exec {
  return async (req: ResourceRequest) => {
    const m = /^http\.(get|post|put|patch|delete|head|options|request)$/.exec(req.name);
    if (!m) throw new Error("httpResources: unknown resource " + req.name);
    const fn = instance[m[1]] as (...a: unknown[]) => Promise<{ data: unknown; status: number; statusText?: string; headers: Record<string, unknown> & { toJSON?: () => Record<string, unknown> } }>;
    if (typeof fn !== "function") throw new Error("httpResources: instance has no ." + m[1]);
    const r = await fn.apply(instance, req.args);
    return { data: r.data, status: r.status, statusText: r.statusText ?? "", headers: r.headers?.toJSON ? r.headers.toJSON() : { ...r.headers } };
  };
}

export function restResources(baseUrl: string, { token, headers = {}, fetchImpl = fetch, envelopeErrors = false }: RestResourcesOpts = {}): Exec {
  const base = baseUrl.replace(/\/$/, "");
  return async (req: ResourceRequest) => {
    const m = /^api\.(get|post|put|patch|delete|head|options)$/.exec(req.name);
    if (!m) throw new Error("restResources: unknown resource " + req.name + " (use api.get/api.post/...)");
    const method = m[1].toUpperCase();
    const [path, body, reqOpts] = req.args as [string, unknown?, { headers?: Record<string, string> }?];
    let url: string;
    if (typeof path === "string" && path.startsWith("/")) url = base + path;
    else if (typeof path === "string" && /^https?:\/\//.test(path)) {
      if (new URL(path).origin !== new URL(base).origin) throw new Error("restResources: cross-origin request refused: " + path);
      url = path;
    } else throw new Error("restResources: first argument must be an absolute path or same-origin URL, got " + JSON.stringify(path));
    const r = await fetchImpl(url, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: token.startsWith("Bearer ") ? token : "Bearer " + token } : {}),
        ...headers,
        ...(reqOpts?.headers || {}),
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    const isJson = (r.headers.get("content-type") || "").includes("json");
    if (!r.ok && !envelopeErrors) throw new Error(`api.${m[1]} ${path}: ${r.status} ${text.slice(0, 200)}`);
    const hdrs: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (k === "content-type" || k.startsWith("x-")) hdrs[k] = v; });
    return { status: r.status, headers: hdrs, body: isJson && text ? JSON.parse(text) : text };
  };
}
