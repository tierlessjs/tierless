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
        // with the config's own serializer when present. The exec enforces same-origin.
        const base = config.baseURL ? new URL(config.baseURL, typeof location !== "undefined" ? location.href : undefined) : undefined;
        const joined = config.url && /^https?:\/\//.test(config.url)
            ? new URL(config.url)
            : new URL((base ? base.pathname.replace(/\/$/, "") : "") + "/" + String(config.url || "").replace(/^\//, ""), base ? base.origin : (typeof location !== "undefined" ? location.origin : "http://localhost"));
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
        const envelope = await exec({
            op: "resource", tier: "server", name: "api." + method,
            args: [joined.origin + path, config.data === undefined ? undefined : config.data, { headers }],
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
