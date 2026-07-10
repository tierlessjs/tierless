// AUTH CONTRACT: this adapter is for HEADER-authenticated APIs (bearer/API-key tokens the
// interceptor chain attaches — both measured ports). Browsers also send same-origin
// cookies implicitly, and a crossing cannot carry the cookie jar: an app whose SAME-ORIGIN
// api relies on cookie auth must not install this adapter (withCredentials-marked requests
// pin to the fallback, but bare same-origin cookie reliance is invisible to a config scan).
//
// INSTALLATION CONTRACT: install on the app's OWN api client instance — that instance's
// baseURL IS the tier-owned api by definition, wherever it is hosted (both ports serve the
// api on a different origin than the page; that is normal). External services belong on
// separate axios instances without the adapter; only an explicit ABSOLUTE url on the api
// client that leaves the api's own origin falls through to the stock adapter.
/** axios-compatible default param serialization, the recursive visitor semantics:
 *  null/undefined/functions skipped (inside arrays too), arrays as repeated `key[]`,
 *  nested objects as bracketed keys (`filter[status]`), Dates as ISO strings. Standard
 *  percent-encoding (the backend parses url-encoding; axios's cosmetic un-escaping of
 *  [,] etc. is not semantic). */
export function serializeParams(params) {
    const q = new URLSearchParams();
    const visit = (key, v) => {
        if (v === null || v === undefined || typeof v === "function")
            return;
        if (v instanceof Date) {
            q.append(key, v.toISOString());
            return;
        }
        if (Array.isArray(v)) {
            // axios's flat-array rule: primitives repeat as `key[]`; an element that needs
            // further descent (object/array) gets its INDEX (`items[0][id]`) — repeated
            // `items[][id]` parses differently on many backends
            const flat = v.every((x) => x === null || x === undefined || typeof x !== "object" || x instanceof Date);
            v.forEach((item, i) => visit(key + (flat ? "[]" : "[" + i + "]"), item));
            return;
        }
        if (typeof v === "object") {
            for (const [k, w] of Object.entries(v))
                visit(key + "[" + k + "]", w);
            return;
        }
        q.append(key, String(v));
    };
    for (const [k, v] of Object.entries(params))
        visit(k, v);
    return q.toString();
}
const pinned = (c) => 
// text: axios must return the RAW string even for JSON-labeled responses, but the
// crossing's exec parses by content-type; document: browser-specific decoding
!!(c.onUploadProgress || c.onDownloadProgress || c.responseType === "blob" || c.responseType === "stream" || c.responseType === "arraybuffer" || c.responseType === "text" || c.responseType === "document"
    || c.withCredentials // cookie-jar auth (incl. HttpOnly) exists only in the browser — another tier can't reproduce it
    || c.signal || c.cancelToken || (typeof c.timeout === "number" && c.timeout > 0) // in-flight abort/timeout semantics don't cross the exec boundary — the adapter owns them, so these run stock
    || (typeof FormData !== "undefined" && c.data instanceof FormData)
    || (typeof Blob !== "undefined" && c.data instanceof Blob)
    || (typeof ArrayBuffer !== "undefined" && (c.data instanceof ArrayBuffer || ArrayBuffer.isView(c.data)))); // binary bodies would JSON-serialize to {} on the crossing
export function axiosAdapter({ exec, fallback }) {
    return async function tierlessAxiosAdapter(config) {
        if (pinned(config)) {
            if (!fallback)
                throw new Error("tierless axios adapter: browser-pinned config (progress/blob) needs a fallback adapter");
            return fallback(config);
        }
        const method = (config.method || "get").toLowerCase();
        // Full URL from baseURL + url, exactly as axios would combine them; params appended
        // with the config's own serializer when present.
        // a relative baseURL needs SOME base everywhere this adapter runs — the browser has
        // location; on a server tier the placeholder origin only anchors path joining and the
        // origin gate (crossing args stay origin-relative, so it never reaches a socket)
        const base = config.baseURL ? new URL(config.baseURL, typeof location !== "undefined" ? location.href : "http://localhost") : undefined;
        const baseOrigin = base ? base.origin : (typeof location !== "undefined" ? location.origin : "http://localhost");
        const joined = config.url && /^(https?:)?\/\//.test(config.url) // absolute or protocol-relative
            ? new URL(config.url, baseOrigin)
            : base
                ? new URL(base.pathname.replace(/\/$/, "") + "/" + String(config.url || "").replace(/^\//, ""), baseOrigin)
                // no baseURL: axios resolves against the DOCUMENT, not the origin root — on a
                // page at /app/, get("items") targets /app/items
                : new URL(String(config.url || ""), typeof location !== "undefined" ? location.href : baseOrigin + "/");
        // only the app's OWN api crosses as a resource request; an explicit other-origin URL
        // is external I/O — stock behavior via the fallback, never a tier crossing
        if (joined.origin !== baseOrigin) {
            if (!fallback)
                throw new Error("tierless axios adapter: cross-origin request needs a fallback adapter: " + joined.origin);
            return fallback(config);
        }
        let path = joined.pathname + joined.search;
        if (config.params) {
            // axios accepts URLSearchParams directly (Object.keys sees nothing in one)
            const s = typeof config.paramsSerializer === "function" ? config.paramsSerializer(config.params)
                : config.paramsSerializer?.serialize ? config.paramsSerializer.serialize(config.params)
                    : config.params instanceof URLSearchParams ? config.params.toString()
                        : serializeParams(config.params);
            if (s)
                path += (joined.search ? "&" : "?") + s;
        }
        const rawHeaders = config.headers?.toJSON ? config.headers.toJSON() : { ...(config.headers || {}) };
        const headers = {};
        for (const [k, v] of Object.entries(rawHeaders))
            if (v !== undefined && v !== null && typeof v !== "function")
                headers[k.toLowerCase()] = String(v);
        // axios's adapter-level Basic auth: overwrites any configured Authorization header.
        // btoa is Latin-1-only — encode to UTF-8 bytes first so non-ASCII credentials work
        if (config.auth) {
            const cred = (config.auth.username || "") + ":" + (config.auth.password || "");
            headers.authorization = "Basic " + (typeof btoa === "function"
                ? btoa(String.fromCharCode(...new TextEncoder().encode(cred)))
                : Buffer.from(cred, "utf8").toString("base64"));
        }
        // ORIGIN-RELATIVE on purpose: the api namespace is tier-owned — whoever executes the
        // request binds it to ITS OWN base (browser: restResources(origin); a session
        // gateway: its localhost backend). An absolute URL would weld the browser's origin
        // spelling (hostname, counting-relay port) into a request another tier executes.
        const envelope = await exec({
            op: "resource", tier: "server", name: "api." + method,
            args: [path, config.data === undefined ? undefined : config.data, { headers }],
        });
        const response = {
            data: envelope.body,
            status: envelope.status,
            statusText: "",
            headers: envelope.headers,
            config,
            request: {},
        };
        const validate = config.validateStatus === undefined ? (s) => s >= 200 && s < 300 : config.validateStatus;
        if (validate && !validate(envelope.status)) {
            // shaped like AxiosError without depending on axios: their code reads .response/.isAxiosError
            const err = new Error("Request failed with status code " + envelope.status);
            err.response = response;
            err.config = config;
            err.isAxiosError = true;
            err.code = envelope.status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST";
            throw err;
        }
        return response;
    };
}
