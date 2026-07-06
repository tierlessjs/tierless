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
        const res = { data: isJson && text ? JSON.parse(text) : text, status: r.status, statusText: r.statusText, headers: Object.fromEntries(r.headers) };
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
 *  callbacks act on live UI. Serializable configs that no ownership scan could flag.
 *  (Callbacks and FormData/Blob values are caught by the host's generic scan.) */
export function httpPins(req) {
    const cfg = req.args.find((a) => a !== null && typeof a === "object" && ("responseType" in a || "onUploadProgress" in a || "onDownloadProgress" in a));
    const rt = cfg?.responseType;
    return rt === "blob" || rt === "stream" || rt === "arraybuffer";
}
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
export function restResources(baseUrl, { token, headers = {}, fetchImpl = fetch, envelopeErrors = false } = {}) {
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
        if (!r.ok && !envelopeErrors)
            throw new Error(`api.${m[1]} ${path}: ${r.status} ${text.slice(0, 200)}`);
        const hdrs = {};
        r.headers.forEach((v, k) => { if (k === "content-type" || k.startsWith("x-"))
            hdrs[k] = v; });
        return { status: r.status, headers: hdrs, body: isJson && text ? JSON.parse(text) : text };
    };
}
