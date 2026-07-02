// The trusted boundary — Tierless's reference monitor.
//
// Think of Tierless as a fat web-app client that grew too fat for the browser alone, so it sometimes
// runs in Node too. "The client" therefore has two halves — the BROWSER client and the BACKEND client
// (what the rest of these docs call the "server tier") — and the business trusts NEITHER. Both are
// just relocated app code; a continuation arriving from either can be forged, replayed, or mangled.
// All authority therefore lives OUTSIDE them, here, in the api: a small, stateless reference monitor
// that runs in its own OS process (see sidecar.mjs) and mediates every resource call.
//
// The three reference-monitor properties, and where each is met:
//   complete mediation — every call goes through handle(); there is no side door.
//   tamperproof        — it runs in a separate process; the untrusted client is handed only a pipe
//                        (sidecar.mjs), never the api's memory, its signing key, or its registry.
//   verifiable         — it is small, and every path that is not an explicit allow falls through to deny.
//
// The load-bearing idea: the api never trusts the control flow that reached a call. A forged
// continuation can jump to any api.* the app mentions anywhere — so authority is re-checked at THIS
// call, for THIS verified principal, every time. (That is exactly why validating a continuation from
// *inside* the untrusted process is the wrong axis: you cannot validate your way out of an untrusted
// process; you move authority into a trusted one. The api never even sees a continuation — it sees a
// call — which is precisely what makes it robust to a forged one.)
//
// This is the DEFAULT api.* path, and the framework's opinion is scoped deliberately: it owns the
// CONTRACT at the edge — { name, args, token } in, verified principal, mandatory authorize,
// default-deny, { ok, value|error } out, a denial thrown back into the continuation (makeApiExec) so
// a try/catch catches it across tiers — and is agnostic about the TRANSPORT (the pipe sidecar is the
// reference implementation; the same contract over HTTPS to a separately-deployed monitor is a small
// adapter) and silent beyond the edge (your business logic, store, and identity provider — verify()
// is the override point). An in-process resource host remains the labeled degenerate mode for
// single-process mechanics tests and trusted single-tenant tools; it is an opt-out, not the default.

export const PUBLIC = Symbol("tierless.api.PUBLIC");   // deliberately no authorization (a public endpoint)
export const DENY   = Symbol("tierless.api.DENY");     // deliberately always reject (disabled / placeholder)

export class Api {
  // opts.maxArgsBytes — reject a call whose args serialize larger than this (a forged continuation
  //   can't hammer the monitor with a huge payload). opts.rate = { max, windowMs } — per-principal
  //   call budget. Both off by default; they are transient counters, not business state, so the
  //   monitor stays stateless in the sense that matters (nothing it must persist).
  constructor(opts = {}) {
    this._fns = new Map();
    this._audit = [];
    this._maxArgsBytes = opts.maxArgsBytes || 0;
    this._rate = opts.rate || null;
    this._calls = new Map();                               // principal -> { start, count } sliding window
  }

  // Register a server-only function. authorize is MANDATORY: exposing an endpoint and stating who may
  // call it are the same act, so they cannot be separated. Omitting authorize throws HERE — at
  // registration, before the process serves a single call — so an unauthorized endpoint can never
  // ship. To mean "anyone", you must say so with the PUBLIC sentinel; you cannot reach open-by-default
  // through silence. (We can't outlaw a bad authorizer — `() => true` is your call to make — but we
  // can refuse the *accident* of forgetting one.)
  fn(name, def) {
    if (typeof name !== "string" || !name) throw new Error("api.fn: name must be a non-empty string");
    if (this._fns.has(name)) throw new Error(`api.fn(${name}): already registered`);
    if (!def || typeof def.run !== "function") throw new Error(`api.fn(${name}): run must be a function`);
    if (!("authorize" in def)) throw new Error(
      `api.fn(${name}): authorize is required — every endpoint must state who may call it. Pass ` +
      `(principal, args) => boolean, or the PUBLIC sentinel to expose it deliberately, or DENY to ` +
      `disable it. Omitting authorize is a load-time error, never a default-open.`);
    const { authorize, run } = def;
    if (authorize !== PUBLIC && authorize !== DENY && typeof authorize !== "function")
      throw new Error(`api.fn(${name}): authorize must be a function, PUBLIC, or DENY`);
    this._fns.set(name, { authorize, run });
    return this;                                          // chainable
  }

  // Turn a bearer token into the principal it attests, or null for none/invalid. The BASE Api trusts
  // nothing: it knows no signature scheme, so every token is invalid (anonymous) and the only calls
  // that can pass are PUBLIC ones. A deployment subclasses with a regime — JwtApi below; Cognito/OIDC
  // is the same shape with an RS256-over-JWKS check. May be sync or async.
  verify(_token) { return null; }

  // The single entry point and the complete-mediation gate. call = { name, args, token }:
  //   verify the principal  →  resolve the fn  →  authorize THIS call for THIS principal  →  run.
  // Returns { ok:true, value } or { ok:false, error }. Default-deny is structural: anything that is not
  // an explicit allow returns denied, and a denial never leaks why (an unknown name and an unauthorized
  // call look identical to the caller).
  async handle(call) {
    const { name, args = [], token = null } = call || {};
    const entry = this._fns.get(name);
    if (!entry) return this._deny(name, null, "unknown");

    // Resource budget: reject an oversized payload before doing any crypto or running anything.
    if (this._maxArgsBytes) { let n; try { n = JSON.stringify(args).length; } catch { n = Infinity; } if (n > this._maxArgsBytes) return this._deny(name, null, "oversize"); }

    let principal = null;
    try { principal = await this.verify(token); } catch { principal = null; }

    // Rate budget: a per-principal sliding window (anonymous callers share one bucket).
    if (this._rate && !this._allowRate((principal && principal.sub) || "anon")) return this._deny(name, principal, "ratelimited");

    let allowed = false;
    const { authorize, run } = entry;
    if (authorize === DENY) allowed = false;
    else if (authorize === PUBLIC) allowed = true;
    // fail closed: the authorizer must return EXACTLY true; a truthy-but-not-true value or a throw denies.
    else { try { allowed = authorize(principal, args) === true; } catch { allowed = false; } }
    if (!allowed) return this._deny(name, principal, "unauthorized");

    try { const value = await run(args, principal); this._log(name, principal, "ok"); return { ok: true, value }; }
    catch (e) { this._log(name, principal, "error"); return { ok: false, error: String((e && e.message) || e) }; }
  }

  _allowRate(key) {
    const now = Date.now();
    let s = this._calls.get(key);
    if (!s || now - s.start >= this._rate.windowMs) { s = { start: now, count: 0 }; this._calls.set(key, s); }
    s.count++;
    return s.count <= this._rate.max;
  }

  // The registered surface, for tooling (tierless api / tierless types): names + the KIND of
  // authorization only — never the authorizer itself, never the secret.
  fns() {
    return [...this._fns.entries()].map(([name, { authorize }]) => ({
      name, authorize: authorize === PUBLIC ? "PUBLIC" : authorize === DENY ? "DENY" : "per-call",
    }));
  }

  _deny(name, principal, reason) { this._log(name, principal, "deny:" + reason); return { ok: false, error: "denied" }; }
  _log(name, principal, outcome) { this._audit.push({ name, who: (principal && principal.sub) || null, outcome }); }
  audit() { return this._audit.slice(); }                 // the audit trail lives in the trusted process, not the client
}

// ── defineApi: the one-call service definition ─────────────────────────────────────────────────────
// The whole trusted service as one literal: names -> { authorize, run } (authorize stays MANDATORY —
// fn() enforces it at create time, before a single call is served). Pass a function instead of an
// object when a run needs the api instance itself (e.g. a PUBLIC login minting tokens via
// api.issue). Returns { create(secret) }; hand it to sidecarMain (sidecar.mjs) to become a fork
// entry, or create() it yourself for an in-process monitor in tests.
//
//   export default defineApi((api) => ({
//     login:   { authorize: PUBLIC, run: ([creds]) => api.issue(checked(creds), 3600) },
//     getRows: { authorize: PUBLIC, run: () => rows() },
//     addRow:  { authorize: (p) => p != null, run: ([r], p) => addRow(r, p.sub) },
//   }), { maxArgsBytes: 8 * 1024, rate: { max: 300, windowMs: 10_000 } });
export function defineApi(build, opts = {}) {
  const create = (secret) => {
    const api = new JwtApi(secret, opts);
    const fns = typeof build === "function" ? build(api) : build;
    for (const [name, def] of Object.entries(fns)) api.fn(name, def);
    return api;
  };
  return { create, opts };
}

// ── A standard, batteries-included regime ──────────────────────────────────────────────────────────
// A compact HMAC-SHA256 bearer token, base64url(payload).base64url(sig). The api process holds the
// secret; the client only ever carries the opaque token it was issued. (In this prototype the token is
// minted INSIDE the trusted process by a PUBLIC `login` fn, so the secret never crosses the pipe — see
// server-fns.mjs.) This is the "easy to do something secure and standard" path; rolling your own is
// just a different Api subclass that overrides verify().
import { createHmac, timingSafeEqual } from "node:crypto";

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s) => Buffer.from(s, "base64url").toString("utf8");

export class JwtApi extends Api {
  constructor(secret, opts) { super(opts); if (!secret) throw new Error("JwtApi: a signing secret is required"); this._secret = secret; }

  // Issue a token for a principal. In a real system your auth server does this at login; here it sits
  // next to verify so `login` can mint one. ttlSeconds adds an exp claim (omit for a non-expiring token).
  issue(principal, ttlSeconds) {
    const claims = { ...principal };
    if (ttlSeconds) claims.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const body = b64url(JSON.stringify(claims));
    return body + "." + this._sign(body);
  }

  verify(token) {
    if (typeof token !== "string") return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot), sig = token.slice(dot + 1);
    const a = Buffer.from(sig), b = Buffer.from(this._sign(body));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;   // signature must match (constant-time)
    let claims; try { claims = JSON.parse(unb64url(body)); } catch { return null; }
    if (claims && typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) return null;  // expired
    return claims;
  }

  _sign(body) { return createHmac("sha256", this._secret).update(body).digest("base64url"); }
}
