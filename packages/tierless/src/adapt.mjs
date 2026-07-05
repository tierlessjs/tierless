/** An Exec servicing `api.get(path)` / `api.post(path, body)` against a real REST base URL.
 *  Resolves to an ENVELOPE { status, headers, body } — apps read semantics from custom
 *  response headers (pagination counts, permission levels), so they must migrate with the
 *  body. `headers` carries content-type and every x-* header. Non-2xx throws, unwinding
 *  into the workflow's own try/catch like any resource error. */
export function restResources(baseUrl, { token, headers = {}, fetchImpl = fetch } = {}) {
    const base = baseUrl.replace(/\/$/, "");
    return async (req) => {
        const m = /^api\.(get|post|put|patch|delete)$/.exec(req.name);
        if (!m)
            throw new Error("restResources: unknown resource " + req.name + " (use api.get/api.post/...)");
        const method = m[1].toUpperCase();
        const [path, body] = req.args;
        if (typeof path !== "string" || !path.startsWith("/"))
            throw new Error("restResources: first argument must be an absolute path, got " + JSON.stringify(path));
        const r = await fetchImpl(base + path, {
            method,
            headers: {
                ...(body !== undefined ? { "content-type": "application/json" } : {}),
                ...(token ? { authorization: token.startsWith("Bearer ") ? token : "Bearer " + token } : {}),
                ...headers,
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const text = await r.text();
        const isJson = (r.headers.get("content-type") || "").includes("json");
        if (!r.ok)
            throw new Error(`api.${m[1]} ${path}: ${r.status} ${text.slice(0, 200)}`);
        const hdrs = {};
        r.headers.forEach((v, k) => { if (k === "content-type" || k.startsWith("x-"))
            hdrs[k] = v; });
        return { status: r.status, headers: hdrs, body: isJson ? JSON.parse(text) : text };
    };
}
