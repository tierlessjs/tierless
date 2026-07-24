// Sealed cookie authority — the GATEWAY side (ROADMAP: "gateway-mediated cookie
// authority, sealed"). The gateway mints a secret key at boot and never shares it.
// Authority is never stored: the browser trades its jar cookie for a sealed BLOB
// (`reseal`), carries the blob on every crossing, and the exec here decrypts, uses,
// and forgets. A set-cookie observed on ANY mediated backend response becomes an
// in-band rotation: the envelope carries a fresh blob plus a short-lived CLAIM
// ticket whose HTTP replay (`claim`) plants the httpOnly cookie in the real jar —
// script cannot write httpOnly, so a ws frame cannot.
//
// Two properties this preserves, worth stating because they are the point:
//   - httpOnly's guarantee: page script holds the blob but cannot read the JWT
//     inside — XSS can use the session (as it can stock same-origin XHR) but not
//     exfiltrate the token.
//   - no added lifetime: the backend still validates the decrypted cookie; a stolen
//     blob is worth exactly a stolen browser session. Claim tickets alone expire
//     (default 30 s) because that URL-shaped request is the loggable, replayable one.
//
// A gateway restart self-heals: blobs die with the key, sockets reconnect, and the
// page reseals from the jar.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Exec, ResourceRequest } from "./types.mjs";
import { restResources } from "./adapt.mjs";
import { SESSION_AUTH_HEADER, AUTH_FIELD } from "./adapt-session-auth.mjs";

export interface CookieAuthorityOpts {
  /** The backend the exec services crossings against (localhost, as deployed). */
  backendUrl: string;
  /** Page origins allowed to call reseal/claim — the same gate the ws upgrade uses.
   *  These endpoints trade credentials, so the CORS check IS the security boundary. */
  allowedOrigins: Iterable<string>;
  /** Claim-ticket lifetime; the ticket replays Set-Cookie, so it stays short. */
  claimTtlMs?: number;
  fetchImpl?: typeof fetch;
  /** GET paths to pre-fetch at the ws upgrade (boot preboot): the gateway fetches each with
   *  the upgrade's own cookie and hands the envelopes to the browser in the hello, so the
   *  boot data crosses DURING bundle download and the first crossings join it. Read-only,
   *  idempotent GETs only — never a mutation. */
  prebootPaths?: string[];
  /** Test seam. */
  now?: () => number;
}

interface SessionPayload { p: "session"; c: string; iat: number }
interface ClaimPayload { p: "claim"; sc: string[]; iat: number }

/** Apply set-cookie lines to a cookie request-header string: name=value pairs win,
 *  Max-Age<=0 / a past Expires / an empty value deletes. Attributes beyond liveness
 *  are the browser jar's business (the claim replays the raw lines for that). */
export function mergeCookies(header: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(";");
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const a = attrs.join(";").toLowerCase();
    const maxAge = /max-age=(-?\d+)/.exec(a);
    const expires = /expires=([^;]+)/.exec(a);
    const dead = value === "" || (maxAge ? Number(maxAge[1]) <= 0 : !!expires && Date.parse(expires[1]) < Date.now());
    if (dead) jar.delete(name); else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function cookieAuthority({ backendUrl, allowedOrigins, claimTtlMs = 30_000, fetchImpl, prebootPaths = [], now = Date.now }: CookieAuthorityOpts): { exec: Exec; handleHttp(req: IncomingMessage, res: ServerResponse): boolean; hello(cookie: string, opts?: { auth?: boolean; preboot?: boolean }): Promise<{ blob: string | null; sealed: boolean; preboot?: Record<string, unknown> }> } {
  const key = randomBytes(32);   // per boot, shared with no one
  const allowed = new Set(allowedOrigins);
  const baseFetch: typeof fetch = fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  const seal = (payload: SessionPayload | ClaimPayload): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
  };
  const open = (blob: string): SessionPayload | ClaimPayload | null => {
    try {
      const raw = Buffer.from(blob, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as SessionPayload | ClaimPayload;
    } catch { return null; }   // wrong key (gateway restarted), tampered, or garbage
  };

  const exec: Exec = async (req) => {
    const r = req as ResourceRequest;
    const [path, data, reqOpts] = (r.args ?? []) as [unknown, unknown, { headers?: Record<string, string> }?];
    const headers = { ...(reqOpts?.headers ?? {}) };
    const blob = headers[SESSION_AUTH_HEADER];
    delete headers[SESSION_AUTH_HEADER];   // the backend never sees the blob
    let cookie = "";
    if (blob) {
      const p = open(blob);
      if (p?.p === "session") cookie = p.c;   // an unopenable blob = no authority; the backend answers 401 and the page reseals
    }
    if (cookie) headers.cookie = cookie;
    // capture set-cookie at the FETCH layer: restResources rightly drops it from the
    // envelope (browsers never expose it to script), but rotation is exactly this signal
    const captured: string[] = [];
    const capturing: typeof fetch = async (...a) => {
      const resp = await baseFetch(...a);
      captured.push(...((resp.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []));
      return resp;
    };
    // upstreamIdentity: the reply is deflated by the socket anyway — asking the backend
    // for gzip would burn a gzip there and a gunzip here for a hop that is normally local
    const inner = restResources(backendUrl, { envelopeErrors: true, fetchImpl: capturing, upstreamIdentity: true });
    const env = await inner({ ...r, args: [path, data, { ...(reqOpts ?? {}), headers }] }) as Record<string, unknown>;
    if (captured.length) {
      env[AUTH_FIELD] = {
        blob: seal({ p: "session", c: mergeCookies(cookie, captured), iat: now() }),
        claim: seal({ p: "claim", sc: captured, iat: now() }),
      };
    }
    return env;
  };

  // CORS is the boundary here: these endpoints trade credentials, and only sockets/pages
  // from OUR origins may use them — the same posture as the ws upgrade's origin gate.
  const cors = (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = String(req.headers.origin ?? "");
    if (!allowed.has(origin)) { res.statusCode = 403; res.end("origin not allowed"); return false; }
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("vary", "origin");
    res.setHeader("cache-control", "no-store");
    return true;
  };

  const handleHttp = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = (req.url ?? "").split("?")[0];
    if (url === "/__tierless/reseal" && req.method === "GET") {
      if (!cors(req, res)) return true;
      const cookie = String(req.headers.cookie ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ blob: cookie ? seal({ p: "session", c: cookie, iat: now() }) : null }));
      return true;
    }
    if (url === "/__tierless/claim" && req.method === "POST") {
      if (!cors(req, res)) return true;
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => { size += c.length; if (size <= 8192) chunks.push(c); });
      req.on("end", () => {
        const p = size <= 8192 ? open(Buffer.concat(chunks).toString("utf8")) : null;
        if (!p || p.p !== "claim" || now() - p.iat > claimTtlMs) { res.statusCode = 403; res.end("invalid or expired claim"); return; }
        res.setHeader("set-cookie", p.sc);   // the raw lines, attributes intact — a real HTTP response is the one place httpOnly can be planted
        res.statusCode = 204;
        res.end();
      });
      return true;
    }
    return false;
  };

  // The ws-upgrade "hello": seal the upgrade's cookie into a startup blob (reseal folded
  // into the handshake — no round trip) and pre-fetch the boot GETs with that cookie. Both
  // are per-call toggleable so a measured run can isolate each lever without a rebuild.
  // `sealed: true` declares that THIS gateway mediates cookie authority even when the
  // blob is null (no cookie at the upgrade — pre-login): the browser wrapper then skips
  // the useless HTTP reseal and lets the in-band rotation deliver the first blob. A
  // gateway with no authority sends sealed:false (attachTierless's default hello), which
  // is what lets adapt-auto's auth:"auto" cost header-auth apps nothing.
  const hello = async (cookie: string, { auth = true, preboot = true }: { auth?: boolean; preboot?: boolean } = {}): Promise<{ blob: string | null; sealed: boolean; preboot?: Record<string, unknown> }> => {
    const blob = auth && cookie ? seal({ p: "session", c: cookie, iat: now() }) : null;
    if (!preboot || !cookie || !prebootPaths.length) return { blob, sealed: auth };
    const inner = restResources(backendUrl, { envelopeErrors: true, fetchImpl: baseFetch, upstreamIdentity: true });
    const pb: Record<string, unknown> = {};
    await Promise.all(prebootPaths.map(async (path) => {
      try { pb[path] = await inner({ op: "resource", tier: "server", name: "api.get", args: [path, undefined, { headers: { cookie } }] } as ResourceRequest); }
      catch { /* a preboot GET that fails just isn't offered — the app fetches it normally */ }
    }));
    return { blob, sealed: auth, preboot: pb };
  };

  return { exec, handleHttp, hello };
}
