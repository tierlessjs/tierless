/** The header a crossing carries the sealed blob in; the gateway strips it before the
 *  backend ever sees the request. Shared constant with session-auth.mts (gateway side). */
export const SESSION_AUTH_HEADER = "x-tierless-session-auth";
/** The rotation annotation key on an exec envelope. Stripped here before the app sees it. */
export const AUTH_FIELD = "__tierlessAuth";
export function cookieSessionAuth({ gateway, channelName = "tierless-session-auth", fetchImpl, hello, awaitClaims = false }) {
    const f = fetchImpl ?? ((...a) => fetch(...a));
    const base = gateway.replace(/\/$/, "");
    let blob = null;
    // preboot join buffer: GET path -> the envelope the gateway pre-fetched at upgrade. A
    // crossing whose path is here returns it instead of round-tripping. Consumed once (a
    // re-fetch then goes to the network, fresh) — boot GETs are read-once.
    const preboot = new Map();
    const seedPreboot = (pb) => {
        if (pb)
            for (const [k, v] of Object.entries(pb))
                preboot.set(k, v);
    };
    const reseal = async () => {
        try {
            const r = await f(base + "/__tierless/reseal", { credentials: "include" });
            if (r.ok)
                blob = (await r.json()).blob;
        }
        catch { /* gateway unreachable: crossings go without auth and surface the app's own errors */ }
    };
    // startup: prefer the hello (reseal folded into the ws upgrade). The gateway's own
    // declaration decides the blob-less case: sealed:false = no cookie authority there, so
    // skip the useless reseal and every attach no-ops (this is what makes wrapping
    // unconditionally — adapt-auto's auth:"auto" — free for header-auth apps); sealed:true
    // = authority but no cookie at the upgrade (pre-login) — the first rotation delivers
    // the blob in-band, nothing to reseal. An UNDECLARED blob-less hello (a pre-`sealed`
    // gateway, or the connection's no-hello safety net) falls back to the HTTP reseal —
    // the pre-hello behavior, unchanged. No hello configured = HTTP reseal.
    let ready = hello
        ? hello.then((h) => { seedPreboot(h?.preboot); if (h?.blob)
            blob = h.blob;
        else if (h?.sealed === undefined)
            return reseal(); }, () => reseal())
        : reseal();
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(channelName);
    if (channel)
        channel.onmessage = () => { ready = reseal(); };
    const claimThenBroadcast = async (claim) => {
        // claim FIRST: hearers reseal from the jar, so the jar must be current when they do
        try {
            await f(base + "/__tierless/claim", { method: "POST", body: claim, credentials: "include" });
        }
        catch { /* the jar copy is continuity (reloads, other tabs) — this session already holds the new blob */ }
        channel?.postMessage("rotated");
    };
    const attach = (req) => {
        if (!blob)
            return req;
        const [path, data, opts] = (req.args ?? []);
        return { ...req, args: [path, data, { ...(opts ?? {}), headers: { ...(opts?.headers ?? {}), [SESSION_AUTH_HEADER]: blob } }] };
    };
    const rotateFrom = (env) => {
        const auth = env?.[AUTH_FIELD];
        if (!auth)
            return;
        blob = auth.blob;
        delete env[AUTH_FIELD];
        const done = claimThenBroadcast(auth.claim);
        if (awaitClaims)
            return done;
        void done;
    };
    return {
        wrap: (inner) => async (req) => {
            await ready;
            // preboot JOIN: a GET whose value the gateway pre-fetched at upgrade returns from the
            // buffer — no crossing, the data fetch already happened during bundle download.
            const rr = req;
            if (rr.name === "api.get") {
                const path = (rr.args ?? [])[0];
                if (preboot.has(path)) {
                    const env = preboot.get(path);
                    preboot.delete(path);
                    return env;
                }
            }
            let env = await inner(attach(req));
            await rotateFrom(env);
            if (env?.status === 401) {
                await reseal();
                if (blob) {
                    env = await inner(attach(req));
                    await rotateFrom(env);
                }
            }
            return env;
        },
    };
}
