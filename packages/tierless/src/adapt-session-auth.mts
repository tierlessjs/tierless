// Sealed cookie authority — the BROWSER side (ROADMAP: "gateway-mediated cookie
// authority, sealed"). For apps whose API authenticates with an httpOnly cookie the
// page cannot read: the gateway seals the cookie under a boot-time key and the page
// carries the opaque BLOB on every crossing instead — authority travels with the
// request, the gateway holds no credentials, and script can USE the session without
// ever reading the token (httpOnly's actual guarantee, preserved through the socket).
//
// This module holds the blob and wraps a session exec:
//   - startup: a `reseal` request (same-site fetch, cookie rides it) trades the jar's
//     cookie for a blob; crossings hold until it settles.
//   - every crossing: the blob rides a header the gateway strips before the backend.
//   - rotation, in-band: when the gateway saw a set-cookie on ANY mediated response
//     (apps roll cookies on arbitrary responses, not just login), the envelope carries
//     a new blob and a short-lived claim ticket. Swap the blob, then post the ticket to
//     `claim` — its HTTP response replays the Set-Cookie so the real jar stays current
//     (a ws frame cannot plant an httpOnly cookie) — then broadcast, in that order:
//     hearers reseal FROM the jar the claim just updated.
//   - other tabs: a BroadcastChannel message means someone rotated — reseal.
//   - recovery: a 401 means authority died without crossing this socket (another
//     tab's logout, a password change). Reseal from the jar and retry ONCE — the
//     request was rejected by auth middleware before any work, so the retry is safe;
//     a second 401 propagates, which is stock behavior.
import type { Exec, ResourceRequest } from "./types.mjs";

/** The header a crossing carries the sealed blob in; the gateway strips it before the
 *  backend ever sees the request. Shared constant with session-auth.mts (gateway side). */
export const SESSION_AUTH_HEADER = "x-tierless-session-auth";
/** The rotation annotation key on an exec envelope. Stripped here before the app sees it. */
export const AUTH_FIELD = "__tierlessAuth";

/** What the gateway delivers in the ws "hello" the instant the socket is up (server side:
 *  session-auth.mts cookieAuthority.hello, wired through attachTierless). `blob` folds the
 *  reseal round trip INTO the upgrade — the gateway seals the upgrade's own cookie and hands
 *  it back, so no startup HTTP reseal is needed. `preboot` is a map of GET path -> envelope
 *  the gateway pre-fetched at upgrade (docs boot preboot): the first crossings JOIN it. */
export interface SessionHello { blob: string | null; preboot?: Record<string, unknown> | null }

export interface CookieSessionAuthOpts {
  /** The gateway's http(s) origin, e.g. `http://localhost:5780`. */
  gateway: string;
  /** BroadcastChannel name for cross-tab rotation. Tabs sharing a jar must share it. */
  channelName?: string;
  fetchImpl?: typeof fetch;
  /** The session socket's "hello" (adapt-session-auth SessionHello). When present, the
   *  startup blob comes from it — no HTTP reseal round trip on the critical path — and its
   *  preboot map seeds the join buffer. Absent = the pre-hello behavior: HTTP reseal at
   *  startup. Rotation/401 recovery still uses the HTTP reseal endpoint either way. */
  hello?: Promise<SessionHello>;
}

interface Rotation { blob: string; claim: string }

export function cookieSessionAuth({ gateway, channelName = "tierless-session-auth", fetchImpl, hello }: CookieSessionAuthOpts): { wrap(inner: Exec): Exec } {
  const f: typeof fetch = fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = gateway.replace(/\/$/, "");
  let blob: string | null = null;
  // preboot join buffer: GET path -> the envelope the gateway pre-fetched at upgrade. A
  // crossing whose path is here returns it instead of round-tripping. Consumed once (a
  // re-fetch then goes to the network, fresh) — boot GETs are read-once.
  const preboot = new Map<string, unknown>();
  const seedPreboot = (pb: Record<string, unknown> | null | undefined): void => {
    if (pb) for (const [k, v] of Object.entries(pb)) preboot.set(k, v);
  };

  const reseal = async (): Promise<void> => {
    try {
      const r = await f(base + "/__tierless/reseal", { credentials: "include" });
      if (r.ok) blob = ((await r.json()) as { blob: string | null }).blob;
    } catch { /* gateway unreachable: crossings go without auth and surface the app's own errors */ }
  };
  // startup: prefer the hello (reseal folded into the ws upgrade). A hello with no blob
  // (auth disabled, or a gateway that doesn't seal) falls back to the HTTP reseal, so the
  // startup path degrades to the pre-hello behavior. No hello configured = HTTP reseal.
  let ready = hello
    ? hello.then((h) => { seedPreboot(h?.preboot); if (h?.blob) blob = h.blob; else return reseal(); }, () => reseal())
    : reseal();

  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(channelName);
  if (channel) channel.onmessage = () => { ready = reseal(); };

  const claimThenBroadcast = async (claim: string): Promise<void> => {
    // claim FIRST: hearers reseal from the jar, so the jar must be current when they do
    try { await f(base + "/__tierless/claim", { method: "POST", body: claim, credentials: "include" }); }
    catch { /* the jar copy is continuity (reloads, other tabs) — this session already holds the new blob */ }
    channel?.postMessage("rotated");
  };

  const attach = (req: ResourceRequest): ResourceRequest => {
    if (!blob) return req;
    const [path, data, opts] = (req.args ?? []) as [unknown, unknown, { headers?: Record<string, string> }?];
    return { ...req, args: [path, data, { ...(opts ?? {}), headers: { ...(opts?.headers ?? {}), [SESSION_AUTH_HEADER]: blob } }] };
  };

  const rotateFrom = (env: unknown): void => {
    const auth = (env as Record<string, unknown> | null)?.[AUTH_FIELD] as Rotation | undefined;
    if (!auth) return;
    blob = auth.blob;
    delete (env as Record<string, unknown>)[AUTH_FIELD];
    void claimThenBroadcast(auth.claim);
  };

  return {
    wrap: (inner) => async (req) => {
      await ready;
      // preboot JOIN: a GET whose value the gateway pre-fetched at upgrade returns from the
      // buffer — no crossing, the data fetch already happened during bundle download.
      const rr = req as ResourceRequest;
      if (rr.name === "api.get") {
        const path = (rr.args ?? [])[0] as string;
        if (preboot.has(path)) { const env = preboot.get(path); preboot.delete(path); return env; }
      }
      let env = await inner(attach(req as ResourceRequest));
      rotateFrom(env);
      if ((env as { status?: number } | null)?.status === 401) {
        await reseal();
        if (blob) {
          env = await inner(attach(req as ResourceRequest));
          rotateFrom(env);
        }
      }
      return env;
    },
  };
}
