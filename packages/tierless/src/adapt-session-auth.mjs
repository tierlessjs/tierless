/** The header a crossing carries the sealed blob in; the gateway strips it before the
 *  backend ever sees the request. Shared constant with session-auth.mts (gateway side). */
export const SESSION_AUTH_HEADER = "x-tierless-session-auth";
/** The rotation annotation key on an exec envelope. Stripped here before the app sees it. */
export const AUTH_FIELD = "__tierlessAuth";
export function cookieSessionAuth({ gateway, channelName = "tierless-session-auth", fetchImpl }) {
    const f = fetchImpl ?? ((...a) => fetch(...a));
    const base = gateway.replace(/\/$/, "");
    let blob = null;
    const reseal = async () => {
        try {
            const r = await f(base + "/__tierless/reseal", { credentials: "include" });
            if (r.ok)
                blob = (await r.json()).blob;
        }
        catch { /* gateway unreachable: crossings go without auth and surface the app's own errors */ }
    };
    let ready = reseal();
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
        void claimThenBroadcast(auth.claim);
    };
    return {
        wrap: (inner) => async (req) => {
            await ready;
            let env = await inner(attach(req));
            rotateFrom(env);
            if (env?.status === 401) {
                await reseal();
                if (blob) {
                    env = await inner(attach(req));
                    rotateFrom(env);
                }
            }
            return env;
        },
    };
}
