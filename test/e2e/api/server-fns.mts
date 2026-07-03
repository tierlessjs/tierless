// Example server-only functions — the trusted compute behind the api boundary. This module runs ONLY
// in the sidecar process; the untrusted client never imports it, never sees the secret, never reaches
// the backing store. It is also the sidecar entry point: when forked with TIERLESS_SIDECAR=1 it mints
// its own signing secret and serves the pipe (see the tail).
//
// The point of the examples is to show the whole authorization vocabulary in one place:
//   PUBLIC                              login, listArticles   — deliberately open (you can have public apis)
//   (p) => p != null                    whoami, publishArticle — any authenticated principal
//   (p, [id]) => p.role === "admin"     deleteUser            — fine-grained, per-call, per-args authority
//   DENY                                dangerousMaintenance  — wired but closed
// Every one of them is re-checked on every call against a freshly-verified principal, so it does not
// matter how the (untrusted, possibly forged) continuation arrived at the call.

import { JwtApi, PUBLIC, DENY, sidecarMain } from "tierless/api";

// Toy backing state — stands in for whatever real resource the trusted compute talks to. It lives in
// the sidecar's memory; the client can only reach it through an authorized fn.
interface User { pass: string; sub: string; role: string }
// The principal object issue()d into the token only ever carries {sub,role} — narrower than
// the backing-store User record (which also has `pass`), so it needs its own cast target.
interface AuthPrincipal { sub: string; role: string }
const USERS: Record<string, User> = {
  alice: { pass: "wonderland", sub: "alice", role: "admin" },
  bob:   { pass: "builder",    sub: "bob",   role: "user" },
};
interface Article { slug: string; title: string; author: string }
let ARTICLES: Article[] = [{ slug: "hello", title: "Hello world", author: "alice" }];

export function makeApi(secret: string | Uint8Array) {
  const api = new JwtApi(secret);

  // PUBLIC: login must be reachable before you hold a token. It checks credentials and mints a token
  // INSIDE the trusted process, so the signing secret never crosses the pipe. The client gets back an
  // opaque string it simply carries.
  api.fn("login", { authorize: PUBLIC, run: (args) => {
    const [creds] = args as [{ user: string; pass: string } | undefined];
    const u = creds && USERS[creds.user];
    if (!u || u.pass !== creds!.pass) throw new Error("bad credentials");
    return api.issue({ sub: u.sub, role: u.role }, 3600);
  } });

  // PUBLIC read — "there is such a thing as public apis."
  api.fn("listArticles", { authorize: PUBLIC, run: () => ARTICLES.map((a) => ({ slug: a.slug, title: a.title })) });

  // Any authenticated principal.
  api.fn("whoami", { authorize: (p) => p != null, run: (_args, p) => p });

  // Must be logged in; the server validates and "stores", scoping authorship to the verified principal
  // (never to anything the client claimed).
  api.fn("publishArticle", { authorize: (p) => p != null, run: (args, p) => {
    const [article] = args as [{ title: string } | undefined];
    if (!article || !article.title) throw new Error("title required");
    const saved: Article = { slug: String(article.title).toLowerCase().replace(/\s+/g, "-"), title: article.title, author: (p as unknown as AuthPrincipal).sub };
    ARTICLES.push(saved);
    return saved;
  } });

  // The escalation target — admin only, and only on a string id. THIS is exactly what a forged
  // continuation would try to reach; authority is decided here, on this principal and these args.
  api.fn("deleteUser", { authorize: (p, [id]) => p != null && (p as unknown as AuthPrincipal).role === "admin" && typeof id === "string", run: (args) => {
    const [id] = args as [string];
    const existed = id in USERS;
    delete USERS[id];
    return { deleted: id, existed };
  } });

  // The audit trail lives in the trusted process (not the client), and reading it is itself an
  // admin-only resource — auditing the auditor.
  api.fn("auditTail", { authorize: (p) => p != null && (p as unknown as AuthPrincipal).role === "admin", run: (args) => { const [n = 20] = args as [number?]; return api.audit().slice(-n); } });

  // Deliberately disabled — wired but closed, no code path can run it.
  api.fn("dangerousMaintenance", { authorize: DENY, run: () => { throw new Error("must never run"); } });

  return api;
}

// Fork entry: does nothing on a normal import; forked by startSidecar it mints a fresh secret
// in-process (the untrusted parent never holds it) and serves the pipe.
sidecarMain(makeApi);
