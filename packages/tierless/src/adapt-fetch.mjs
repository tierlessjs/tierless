const NO_BODY_STATUS = new Set([204, 205, 304]);
const abortError = () => typeof DOMException !== "undefined" ? new DOMException("The operation was aborted.", "AbortError") : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
export function fetchAdapter({ exec, origin, pins, crossable, fetchImpl }) {
    const f = fetchImpl ?? ((...a) => fetch(...a));
    const apiOrigin = () => {
        const o = typeof origin === "function" ? origin() : origin;
        return new URL(o || "/", typeof location !== "undefined" ? location.href : "http://localhost").origin;
    };
    return async (input, init = {}) => {
        // a Request object input is browser-pinned by shape (see header)
        if (typeof input !== "string" && !(input instanceof URL))
            return f(input, init);
        if (typeof window === "undefined" || typeof location === "undefined")
            return f(input, init);
        const target = new URL(String(input), location.href);
        const headers = new Headers(init.headers);
        const method = String(init.method || "GET").toLowerCase();
        const decide = () => {
            const forced = crossable?.(target, init);
            if (forced !== undefined)
                return forced;
            return target.origin === apiOrigin() &&
                (init.body === undefined || init.body === null || typeof init.body === "string") &&
                (headers.get("accept") || "").toLowerCase().includes("application/json") &&
                !(pins?.(target, init) ?? false);
        };
        if (!decide())
            return f(input, init);
        if (init.signal?.aborted)
            throw abortError();
        const plainHeaders = {};
        headers.forEach((v, k) => { plainHeaders[k] = v; });
        const crossing = Promise.resolve(exec({
            op: "resource",
            tier: "server",
            name: "api." + method,
            // ORIGIN-RELATIVE on purpose: whoever executes the request binds the path to ITS
            // OWN base (a session gateway: its localhost backend; a direct exec: this origin)
            args: [target.pathname + target.search, init.body === undefined || init.body === null ? undefined : init.body, { headers: plainHeaders }],
        }));
        let envelope;
        if (init.signal) {
            const signal = init.signal;
            envelope = await new Promise((resolve, reject) => {
                const onAbort = () => reject(abortError());
                signal.addEventListener("abort", onAbort, { once: true });
                crossing.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
            });
        }
        else {
            envelope = await crossing;
        }
        const text = typeof envelope.body === "string" ? envelope.body : envelope.body === undefined ? "" : JSON.stringify(envelope.body);
        return new Response(NO_BODY_STATUS.has(envelope.status) || text === "" ? null : text, { status: envelope.status, headers: envelope.headers });
    };
}
