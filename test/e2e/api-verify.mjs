// Headless proof for the trust boundary (design §7), the right way round this time.
//
// Tierless's "client" — the browser client AND the relocated backend client (the "server" tier) — is
// untrusted: it is just a fat web app that sometimes runs in Node. So authority cannot live in it. It
// lives in the API: a small, stateless REFERENCE MONITOR in its own OS process, reached over a local
// pipe (sidecar). This proof drives that monitor two ways:
//
//   A. unit properties, in-process — the load-time authorize mandate, default-deny, PUBLIC/DENY, the
//      JWT regime (sign/verify/tamper/expiry), fail-closed authorizers, and roll-your-own verify.
//   B. the real boundary, over a forked process and a pipe — a forged continuation cannot escalate
//      (authority is re-checked at the call), and a forged token cannot escalate (the secret lives
//      only in the monitor). From the monitor's side a "forged continuation" is indistinguishable from
//      a hostile client calling the endpoint directly — which is exactly why moving authority here, and
//      never trusting the control flow that arrived, is the correct axis.

import { Api, JwtApi, PUBLIC, DENY } from "tierless/api";
import { startSidecar } from "tierless/api";
import { makeCounter } from "../lib/check.mjs";

const { check, counts } = makeCounter();
const threw = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

console.log("Proof: the api is an external reference monitor — authority outside the untrusted client\n");

// ── A. Unit properties (in-process) ─────────────────────────────────────────────────────────────────
console.log("A. the monitor's rules");

// A1 — exposure and authorization are the same gate: omitting authorize is a LOAD-TIME error.
check("omitting authorize is a load-time error (cannot ship an unauthorized endpoint)",
  threw(() => new Api().fn("oops", { run: () => 1 }), /authorize is required/));
check("a missing run is a load-time error too",
  threw(() => new Api().fn("oops", { authorize: PUBLIC }), /run must be a function/));
check("a duplicate name is a load-time error",
  threw(() => { const a = new Api(); a.fn("x", { authorize: PUBLIC, run: () => 1 }); a.fn("x", { authorize: PUBLIC, run: () => 2 }); }, /already registered/));

// A2 — default-deny floor: the BASE Api knows no signature scheme, so every token is anonymous and only
// PUBLIC calls pass. A regime can only ever ADD authority above this floor, never remove it.
{
  const base = new Api();
  base.fn("open", { authorize: PUBLIC, run: () => "ok" });
  base.fn("guarded", { authorize: (p) => p != null, run: () => "secret" });
  check("default-deny floor: PUBLIC passes on the base Api", (await base.handle({ name: "open", token: "anything" })).ok === true);
  check("default-deny floor: a guarded call is denied (base verify trusts no token)", (await base.handle({ name: "guarded", token: "anything" })).ok === false);
  check("an unknown endpoint is denied, opaquely", (await base.handle({ name: "nope" })).error === "denied");
}

// A3 — DENY rejects even a valid principal.
{
  const a = new JwtApi("s");
  a.fn("closed", { authorize: DENY, run: () => "nope" });
  const tok = a.issue({ sub: "alice", role: "admin" });
  check("DENY rejects even a fully-valid admin principal", (await a.handle({ name: "closed", token: tok })).ok === false);
}

// A4 — the JWT regime: a signed token round-trips; tamper, wrong secret, and expiry all fail verify.
{
  const a = new JwtApi("super-secret");
  const tok = a.issue({ sub: "bob", role: "user" });
  check("JwtApi: a signed token verifies to its principal", a.verify(tok)?.sub === "bob");
  check("JwtApi: a tampered payload fails verify", a.verify(tok.replace(/^./, (c) => (c === "A" ? "B" : "A"))) === null);
  check("JwtApi: a token from a different secret fails verify", a.verify(new JwtApi("other-secret").issue({ sub: "bob" })) === null);
  check("JwtApi: an expired token fails verify", a.verify(a.issue({ sub: "bob" }, -100)) === null);
}

// A5 — fail closed: an authorizer must return EXACTLY true; truthy-not-true or a throw denies.
{
  const a = new JwtApi("s");
  a.fn("loose", { authorize: () => "yes", run: () => 1 });        // returns a truthy string, not true
  a.fn("boom", { authorize: () => { throw new Error("auth bug"); }, run: () => 1 });
  check("fail-closed: a truthy-but-not-true authorizer denies", (await a.handle({ name: "loose" })).ok === false);
  check("fail-closed: an authorizer that throws denies", (await a.handle({ name: "boom" })).ok === false);
}

// A6 — roll your own: a custom regime is just an Api subclass overriding verify (here, a static API-key
// map). "Easy to do something standard; also easy to roll your own."
{
  class ApiKeyApi extends Api {
    constructor(keys) { super(); this._keys = keys; }
    verify(token) { return this._keys.get(token) || null; }
  }
  const k = new ApiKeyApi(new Map([["k-live-123", { sub: "svc", role: "service" }]]));
  k.fn("ping", { authorize: (p) => p?.role === "service", run: () => "pong" });
  check("roll-your-own verify: a known API key is authorized", (await k.handle({ name: "ping", token: "k-live-123" })).value === "pong");
  check("roll-your-own verify: an unknown API key is denied", (await k.handle({ name: "ping", token: "k-bogus" })).ok === false);
}

// A7 — resource budgets: an oversized payload and a spent per-principal rate budget both deny before
// running anything (a forged continuation cannot hammer the monitor or smuggle a huge payload past it).
{
  const a = new JwtApi("s", { maxArgsBytes: 64, rate: { max: 3, windowMs: 60000 } });
  a.fn("echo", { authorize: PUBLIC, run: ([x]) => x });
  check("budget: an oversized payload is denied before it runs", (await a.handle({ name: "echo", args: ["x".repeat(200)] })).ok === false);
  check("budget: a normal payload runs", (await a.handle({ name: "echo", args: ["hi"] })).ok === true);  // rate call 1/3
  await a.handle({ name: "echo", args: ["2"] });          // 2/3
  await a.handle({ name: "echo", args: ["3"] });          // 3/3
  check("budget: the rate limit denies once the window's call budget is spent", (await a.handle({ name: "echo", args: ["4"] })).ok === false);
}

// ── B. The real boundary (a forked process, over a pipe) ─────────────────────────────────────────────
console.log("\nB. across the process boundary (the sidecar)");

const api = startSidecar(new URL("./api/server-fns.mjs", import.meta.url));
await api.ready();
try {
  // B1/B2 — anonymous: a PUBLIC read works; a guarded call does not.
  check("anonymous PUBLIC read succeeds over the pipe", (await api.call("listArticles")).ok === true);
  check("anonymous guarded call (whoami) is denied", (await api.call("whoami")).ok === false);

  // B3 — login mints a token INSIDE the monitor; bad creds are rejected.
  const bobR = await api.call("login", [{ user: "bob", pass: "builder" }]);
  const aliceR = await api.call("login", [{ user: "alice", pass: "wonderland" }]);
  const bobTok = bobR.value, aliceTok = aliceR.value;
  check("login with good credentials returns a token", bobR.ok === true && typeof bobTok === "string");
  check("login with bad credentials is rejected", (await api.call("login", [{ user: "bob", pass: "wrong" }])).ok === false);

  // B4 — an authenticated call sees the verified principal (not anything the client asserted).
  const who = await api.call("whoami", [], bobTok);
  check("an authenticated call resolves the verified principal", who.ok === true && who.value.sub === "bob");

  // B5 — escalation by REACHING the call. A forged continuation can jump straight to deleteUser; the
  // monitor doesn't care how control flow got there — it re-authorizes for THIS principal and THESE
  // args. Bob (a user) is denied; Alice (an admin) is allowed.
  check("reaching deleteUser as a non-admin is denied (authority re-checked at the call)", (await api.call("deleteUser", ["bob"], bobTok)).ok === false);
  check("the same call as an admin is allowed", (await api.call("deleteUser", ["carol"], aliceTok)).ok === true);

  // B6 — escalation by FORGING the token. The client holds bob's opaque token; flipping the role claim
  // breaks the signature, and the client cannot re-sign — the secret never left the monitor.
  const [body, sig] = bobTok.split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  claims.role = "admin";
  const forged = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url") + "." + sig;
  check("a client-forged 'admin' token fails verify, so the call is denied", (await api.call("deleteUser", ["bob"], forged)).ok === false);

  // B7 — a DENY endpoint is closed across the boundary too.
  check("a DENY endpoint is unreachable over the pipe", (await api.call("dangerousMaintenance")).ok === false);

  // B8 — the audit trail lives in the trusted process and recorded the escalation attempt (who +
  // outcome). Reading it is itself admin-only: an admin can, a user cannot.
  const log = await api.call("auditTail", [50], aliceTok);
  const auditedDeny = log.ok === true && log.value.some((e) => e.name === "deleteUser" && e.who === "bob" && /^deny/.test(e.outcome));
  check("the monitor audited the denied escalation (who=bob, deny) in the trusted process", auditedDeny);
  check("reading the audit trail is itself admin-only", (await api.call("auditTail", [50], bobTok)).ok === false);
} finally {
  api.close();
}

const { pass, fail } = counts();
const ok = fail === 0;
console.log(ok
  ? `\nPASS — the api is an external reference monitor: authority is verified and enforced in a separate process on every call, so neither a forged continuation nor a forged token can escalate, and an endpoint with no authorize cannot ship (${pass} checks)`
  : `\nFAIL (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
