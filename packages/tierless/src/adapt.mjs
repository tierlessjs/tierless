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
/** The server-side TWIN of an app's own axios instance: the same call surface
 *  (`get(url, config)`, `post(url, data, config)`, …) over fetch against the backend's
 *  local base URL, resolving to { data, status, headers, statusText } and rejecting
 *  AxiosError-shaped on non-2xx. Interim stand-in for building the twin from the app's
 *  OWN factory (which needs the pinned-global leases — ports/vikunja/COMPILING.md):
 *  the interceptors' observable effects (Content-Type, Authorization) are reproduced
 *  from the session's token. Params serialize axios-style (arrays as key[]). */
export function twinHttp(baseUrl, { token, headers = {}, fetchImpl = fetch } = {}) {
    const base = baseUrl.replace(/\/$/, "");
    const call = async (method, url, data, config = {}) => {
        // absolute URLs (the browser-side instance's baseURL applied by bindMethods) are
        // RE-HOMED: path + query onto the twin's own base — the gateway reaches the same
        // backend under its local address, whatever origin the page used
        if (/^https?:\/\//.test(url)) {
            const u = new URL(url);
            url = u.pathname + u.search;
        }
        let path = url.startsWith("/") ? base + url : url;
        if (config.params && Object.keys(config.params).length)
            path += (path.includes("?") ? "&" : "?") + serializeParams(config.params);
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
        const hdrs = {};
        r.headers.forEach((v, k) => { if (k === "content-type" || k.startsWith("x-"))
            hdrs[k] = v; }); // all the app reads (pagination, permissions) — date/vary/server would be dead wire weight
        const res = { data: isJson && text ? JSON.parse(text) : text, status: r.status, statusText: r.statusText, headers: hdrs };
        if (r.status < 200 || r.status >= 300) {
            const err = new Error("Request failed with status code " + r.status);
            err.response = res;
            err.isAxiosError = true;
            err.code = r.status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST";
            throw err;
        }
        return res;
    };
    return {
        get: (url, c) => call("get", url, undefined, c),
        delete: (url, c) => call("delete", url, undefined, c),
        head: (url, c) => call("head", url, undefined, c),
        options: (url, c) => call("options", url, undefined, c),
        post: (url, data, c) => call("post", url, data, c),
        put: (url, data, c) => call("put", url, data, c),
        patch: (url, data, c) => call("patch", url, data, c),
    };
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
export function httpPins(req) {
    const KEYS = ["responseType", "onUploadProgress", "onDownloadProgress", "withCredentials", "signal", "cancelToken", "timeout"];
    const cfg = req.args.find((a) => a !== null && typeof a === "object" && KEYS.some((k) => k in a));
    if (!cfg)
        return false;
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
export function crossHttpRequest(instance, req) {
    const m = /^http\.(get|post|put|patch|delete|head|options)$/.exec(req.name);
    if (!m)
        return req;
    const verb = m[1];
    const hasBody = verb === "post" || verb === "put" || verb === "patch";
    const [url, a1, a2] = req.args;
    const extra = (hasBody ? a2 : a1);
    // a CUSTOM paramsSerializer (per-request or instance default) would be bypassed by the
    // crossing's own serialization — those requests run on the instance, where axios
    // applies it. (Default transformRequest is reproduced by wireJson; a custom transform
    // chain is app code the fallback runs faithfully too — it pins via the same rule when
    // it needs a serializer; other custom transforms are a documented divergence.)
    if (extra?.paramsSerializer || instance?.defaults?.paramsSerializer)
        return null;
    const dfltHeaders = instance?.defaults?.headers;
    let config = {
        method: verb, url,
        baseURL: instance?.defaults?.baseURL,
        ...(hasBody ? { data: a1 } : {}),
        ...(extra || {}),
        // axios precedence: common < method-specific defaults < per-request (the plain
        // spread above would have REPLACED the merged defaults with the per-request object)
        headers: {
            ...(dfltHeaders?.common || {}),
            ...(dfltHeaders?.[verb] || {}),
            ...(extra?.headers || {}),
        },
    };
    const finish = (c) => {
        const cUrl = String(c.url || url);
        // an EXPLICIT other-origin URL is external I/O — it runs on the instance (stock
        // fetch semantics: this tier's cookies, IP, CORS), never as a tier crossing
        if (/^(https?:)?\/\//.test(cUrl)) {
            const bo = c.baseURL && /^https?:\/\//.test(String(c.baseURL)) ? new URL(String(c.baseURL)).origin : null;
            if (!bo || new URL(cUrl, bo).origin !== bo)
                return null;
        }
        // axios's combineURLs: trailing slashes off the base, leading off the path, ONE
        // slash between ("https://h/api" + "tasks" must not become "https://h/apitasks");
        // a same-origin PROTOCOL-RELATIVE url (passed the gate above) is absolute, not a
        // path — resolve it against the base's protocol instead of appending it
        const abs = /^https?:\/\//.test(cUrl) ? cUrl
            : /^\/\//.test(cUrl) && c.baseURL ? new URL(cUrl, String(c.baseURL)).toString()
                : c.baseURL ? String(c.baseURL).replace(/\/+$/, "") + "/" + cUrl.replace(/^\/+/, "") : cUrl;
        const rawHeaders = c.headers?.toJSON ? c.headers.toJSON() : { ...(c.headers || {}) };
        const headers = {};
        for (const [k, v] of Object.entries(rawHeaders))
            if (v !== undefined && v !== null && typeof v !== "function" && typeof v !== "object")
                headers[k.toLowerCase()] = String(v);
        const cfg = { headers };
        if (c.params)
            cfg.params = wireJson(c.params);
        return { ...req, args: hasBody ? [abs, wireJson(c.data), cfg] : [abs, cfg] };
    };
    const handlers = [];
    instance?.interceptors?.request?.forEach((h) => handlers.push(h));
    handlers.reverse(); // axios runs request interceptors LIFO
    for (let i = 0; i < handlers.length; i++) {
        const h = handlers[i];
        if (h.runWhen && !h.runWhen(config))
            continue;
        const r = h.fulfilled ? h.fulfilled(config) : config;
        if (r && typeof r.then === "function") {
            return (async () => {
                let c = (await r) || config;
                for (let j = i + 1; j < handlers.length; j++) {
                    const g = handlers[j];
                    if (g.runWhen && !g.runWhen(c))
                        continue;
                    c = ((g.fulfilled ? (await g.fulfilled(c)) : c)) || c;
                }
                return finish(c);
            })();
        }
        config = r || config;
    }
    return finish(config);
}
// What crosses is EXACTLY axios's JSON pass: toJSON honored (models serialize
// themselves), Dates -> ISO strings, undefined and functions dropped — the wire body
// is byte-identical to what the stock adapter would have sent. Never applied to
// pinned requests (FormData/Blob run locally and never reach here).
const wireJson = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
export function httpResources(instance) {
    return async (req) => {
        const m = /^http\.(get|post|put|patch|delete|head|options|request)$/.exec(req.name);
        if (!m)
            throw new Error("httpResources: unknown resource " + req.name);
        const fn = instance[m[1]];
        if (typeof fn !== "function")
            throw new Error("httpResources: instance has no ." + m[1]);
        const r = await fn.apply(instance, req.args);
        return { data: r.data, status: r.status, statusText: r.statusText ?? "", headers: r.headers?.toJSON ? r.headers.toJSON() : { ...r.headers } };
    };
}
export function restResources(baseUrl, { token, headers = {}, fetchImpl = fetch, envelopeErrors = false, upstreamIdentity = false } = {}) {
    const base = baseUrl.replace(/\/$/, "");
    return async (req) => {
        const m = /^api\.(get|post|put|patch|delete|head|options)$/.exec(req.name);
        if (!m)
            throw new Error("restResources: unknown resource " + req.name + " (use api.get/api.post/...)");
        const method = m[1].toUpperCase();
        const [path, body, reqOpts] = req.args;
        let url;
        if (typeof path === "string" && path.startsWith("/"))
            url = base + path;
        else if (typeof path === "string" && /^https?:\/\//.test(path)) {
            if (new URL(path).origin !== new URL(base).origin)
                throw new Error("restResources: cross-origin request refused: " + path);
            url = path;
        }
        else
            throw new Error("restResources: first argument must be an absolute path or same-origin URL, got " + JSON.stringify(path));
        const merged = {
            // no upstream gzip to immediately gunzip: the socket recompresses anyway (see
            // upstreamIdentity). First in the spread so anything explicit still wins.
            ...(upstreamIdentity ? { "accept-encoding": "identity" } : {}),
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(token ? { authorization: token.startsWith("Bearer ") ? token : "Bearer " + token } : {}),
            ...headers,
            ...(reqOpts?.headers || {}),
        };
        // undici's fetch stamps `cache-control: no-cache` onto any request carrying a
        // conditional header (WHATWG fetch §HTTP-network-or-cache: conditional headers flip
        // the cache mode) — and Express's fresh() refuses to 304 exactly when the request
        // says no-cache, so a forwarded If-None-Match could never revalidate. max-age=0 is
        // what a browser reload sends, preempts undici (it only adds no-cache when absent),
        // and leaves the server's conditional handling intact.
        if (Object.keys(merged).some((k) => k.toLowerCase() === "if-none-match") && !Object.keys(merged).some((k) => k.toLowerCase() === "cache-control")) {
            merged["cache-control"] = "max-age=0";
        }
        const r = await fetchImpl(url, {
            method,
            headers: merged,
            ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
        });
        const text = await r.text();
        const isJson = (r.headers.get("content-type") || "").includes("json");
        if (!r.ok && !envelopeErrors)
            throw new Error(`api.${m[1]} ${path}: ${r.status} ${text.slice(0, 200)}`);
        const hdrs = {};
        // etag rides along for conditional crossings (adapt-cache.mts): the browser-side
        // wrap keys its envelope cache on it and revalidates with If-None-Match — which
        // already forwards through reqOpts.headers above, and a 304 is a tiny envelope
        // (envelopeErrors mode), exactly HTTP's own revalidation shape on the socket.
        r.headers.forEach((v, k) => { if (k === "content-type" || k === "etag" || k.startsWith("x-"))
            hdrs[k] = v; });
        return { status: r.status, headers: hdrs, body: isJson && text ? JSON.parse(text) : text };
    };
}
