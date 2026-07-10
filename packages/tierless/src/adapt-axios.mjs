/** axios-compatible default param serialization: null/undefined skipped, arrays as
 *  repeated `key[]`, Dates as ISO strings. Standard percent-encoding (the backend
 *  parses url-encoding; axios's cosmetic un-escaping of [,] etc. is not semantic). */
export function serializeParams(params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v === null || v === undefined)
            continue;
        const one = (x) => (x instanceof Date ? x.toISOString() : typeof x === "object" ? JSON.stringify(x) : String(x));
        if (Array.isArray(v))
            for (const item of v)
                q.append(k + "[]", one(item));
        else
            q.append(k, one(v));
    }
    return q.toString();
}
const pinned = (c) => !!(c.onUploadProgress || c.onDownloadProgress || c.responseType === "blob" || c.responseType === "stream" || c.responseType === "arraybuffer"
    || c.withCredentials // cookie-jar auth (incl. HttpOnly) exists only in the browser — another tier can't reproduce it
    || (typeof FormData !== "undefined" && c.data instanceof FormData)
    || (typeof Blob !== "undefined" && c.data instanceof Blob));
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
        const base = config.baseURL ? new URL(config.baseURL, typeof location !== "undefined" ? location.href : undefined) : undefined;
        const baseOrigin = base ? base.origin : (typeof location !== "undefined" ? location.origin : "http://localhost");
        const joined = config.url && /^(https?:)?\/\//.test(config.url) // absolute or protocol-relative
            ? new URL(config.url, baseOrigin)
            : new URL((base ? base.pathname.replace(/\/$/, "") : "") + "/" + String(config.url || "").replace(/^\//, ""), baseOrigin);
        // only the app's OWN api crosses as a resource request; an explicit other-origin URL
        // is external I/O — stock behavior via the fallback, never a tier crossing
        if (joined.origin !== baseOrigin) {
            if (!fallback)
                throw new Error("tierless axios adapter: cross-origin request needs a fallback adapter: " + joined.origin);
            return fallback(config);
        }
        let path = joined.pathname + joined.search;
        if (config.params && Object.keys(config.params).length) {
            const s = typeof config.paramsSerializer === "function" ? config.paramsSerializer(config.params)
                : config.paramsSerializer?.serialize ? config.paramsSerializer.serialize(config.params)
                    : serializeParams(config.params);
            if (s)
                path += (joined.search ? "&" : "?") + s;
        }
        const rawHeaders = config.headers?.toJSON ? config.headers.toJSON() : { ...(config.headers || {}) };
        const headers = {};
        for (const [k, v] of Object.entries(rawHeaders))
            if (v !== undefined && v !== null && typeof v !== "function")
                headers[k.toLowerCase()] = String(v);
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
