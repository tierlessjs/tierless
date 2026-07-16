// The tierless I/O bottom for fetch-based clients — the fetch twin of adapt-axios.
// Hardened on the Strapi port (its patch 0002 hand-wrote exactly this, ~120 lines per
// app); now the crossability policy is FRAMEWORK-owned and a port supplies only its
// seam and its app-specific pins.
//
//   const tierlessFetch = fetchAdapter({ exec: sessionExec() });
//   // then replace the client's raw `fetch(...)` call sites with `tierlessFetch(...)`
//
// Everything above the call site (default headers, token refresh, error shaping, RTK
// Query) runs untouched: a crossable request is refashioned as a tierless resource
// request (`api.<method>`, origin-relative path, explicit headers — authority the
// client attached rides in the request; no ambient authority) and the reply envelope
// is rebuilt into a real `Response` for the app's own response handling to parse.
//
// NOT crossable — falls through to the host fetch, stock behavior byte for byte:
//   - not in a browser (SSR/twin bundles: the host fetch is already local),
//   - a `Request` object input (its body is a consumed-once stream; introspecting it
//     is not worth diverging from stock),
//   - non-string bodies (FormData/Blob/streams: the browser owns multipart framing
//     and upload semantics),
//   - requests not negotiating JSON (no `Accept: application/json`: blob/text/binary
//     responses can't cross a JSON envelope — conservative: unknown stays stock),
//   - URLs leaving the app's own API origin (external I/O is never a crossing),
//   - anything the app's own `pins` predicate claims (paths whose RESPONSES act on
//     the browser itself — e.g. Set-Cookie auth flows when the gateway runs without
//     sealed cookie authority).
//
// AbortSignal is handled HERE, browser-side, instead of pinning every signal-carrying
// request to stock (the axios-adapter posture): fetch-based clients commonly attach a
// signal to EVERY request (Strapi's RTK Query does), so signal-pins would leave nothing
// at the socket. Abort races the crossing: the caller sees an immediate AbortError
// (fetch semantics), the crossing's eventual reply is discarded. Divergence from stock:
// the wire is not torn down mid-flight — for the small JSON bodies that cross, the
// server completes the handler either way.
import type { Exec, ResourceRequest } from "./types.mjs";

export interface FetchAdapterOpts {
  /** Services crossable requests — `sessionExec()` (or an autoSession execFor). */
  exec: Exec;
  /** The app's API origin; requests to other origins fall through. Default: the page
   *  origin. A function is read per request (apps that discover their backend late). */
  origin?: string | (() => string);
  /** App-specific browser-pins: return true to keep a request on the host fetch. */
  pins?: (url: URL, init: RequestInit) => boolean;
  /** Override the whole crossability decision: true/false forces, undefined applies
   *  the default policy above. */
  crossable?: (url: URL, init: RequestInit) => boolean | undefined;
  /** The fallthrough fetch (default: the host's). */
  fetchImpl?: typeof fetch;
}

interface Envelope { status: number; headers?: Record<string, string>; body?: unknown }

const NO_BODY_STATUS = new Set([204, 205, 304]);
const abortError = (): Error =>
  typeof DOMException !== "undefined" ? new DOMException("The operation was aborted.", "AbortError") : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

export function fetchAdapter({ exec, origin, pins, crossable, fetchImpl }: FetchAdapterOpts): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const f: typeof fetch = fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const apiOrigin = (): string => {
    const o = typeof origin === "function" ? origin() : origin;
    return new URL(o || "/", typeof location !== "undefined" ? location.href : "http://localhost").origin;
  };

  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    // a Request object input is browser-pinned by shape (see header)
    if (typeof input !== "string" && !(input instanceof URL)) return f(input as never, init);
    if (typeof window === "undefined" || typeof location === "undefined") return f(input, init);

    const target = new URL(String(input), location.href);
    const headers = new Headers(init.headers);
    const method = String(init.method || "GET").toLowerCase();

    const decide = (): boolean => {
      const forced = crossable?.(target, init);
      if (forced !== undefined) return forced;
      return target.origin === apiOrigin() &&
        (init.body === undefined || init.body === null || typeof init.body === "string") &&
        (headers.get("accept") || "").toLowerCase().includes("application/json") &&
        !(pins?.(target, init) ?? false);
    };
    if (!decide()) return f(input, init);

    if (init.signal?.aborted) throw abortError();

    const plainHeaders: Record<string, string> = {};
    headers.forEach((v, k) => { plainHeaders[k] = v; });

    const crossing = Promise.resolve(exec({
      op: "resource",
      tier: "server",
      name: "api." + method,
      // ORIGIN-RELATIVE on purpose: whoever executes the request binds the path to ITS
      // OWN base (a session gateway: its localhost backend; a direct exec: this origin)
      args: [target.pathname + target.search, init.body === undefined || init.body === null ? undefined : init.body, { headers: plainHeaders }],
    } as ResourceRequest)) as Promise<Envelope>;

    let envelope: Envelope;
    if (init.signal) {
      const signal = init.signal;
      envelope = await new Promise<Envelope>((resolve, reject) => {
        const onAbort = (): void => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        crossing.then(
          (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
          (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
        );
      });
    } else {
      envelope = await crossing;
    }

    const text = typeof envelope.body === "string" ? envelope.body : envelope.body === undefined ? "" : JSON.stringify(envelope.body);
    return new Response(NO_BODY_STATUS.has(envelope.status) || text === "" ? null : text, { status: envelope.status, headers: envelope.headers });
  };
}
