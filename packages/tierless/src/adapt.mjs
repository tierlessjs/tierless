/** An Exec servicing `api.get(path)` / `api.post(path, body)` — and per-request headers
 *  via `api.get(path, undefined, {headers})` — against a real REST base URL.
 *  Resolves to an ENVELOPE { status, headers, body } — apps read semantics from custom
 *  response headers (pagination counts, permission levels), so they must migrate with the
 *  body. `headers` carries content-type and every x-* header. Non-2xx throws unless
 *  envelopeErrors. `path` may be a full URL only on the base's own origin — this exec
 *  must never become an open proxy. */
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
