// The client-side ROUTE-WORKFLOW shim, served by the Vite plugin as a virtual module and
// injected via transformIndexHtml — the target app's own source needs only the one
// vite.config line. What it does:
//
//   1. Watches SPA navigation (pushState/replaceState/popstate + initial load). When the
//      new location matches a configured route pattern ("/projects/:id/:view"), it starts
//      the route's tierless workflow over the session socket with the extracted params —
//      ONE crossing runs the whole data workflow next to the backend.
//   2. While that workflow is in flight, GET XHRs to the API origin are HELD (they would
//      have been waiting on the network anyway). When the workflow's bundle lands, any
//      held request whose normalized URL matches a bundle key is answered locally —
//      status 200, JSON, zero network; misses proceed over the real network unchanged.
//
// The app's components, stores, and services run untouched: they still "fetch" — the
// answers just arrive from the migrated workflow's one round trip. Non-XHR traffic
// (<img> avatars, css) is deliberately not intercepted. The workflow module authors the
// route's data needs as plain sequential code and returns { [pathAndQuery]: body }.
//
// This file is compiled to plain JS and stringified into the plugin — it must stay
// dependency-free and browser-only. The plugin substitutes __TIERLESS_ROUTES__ (pattern ->
// module id), and the shim imports each workflow module (already transformed: its exports
// are bound actions).
type Envelope = { status?: number; headers?: Record<string, string>; body?: unknown };
type Bundle = Record<string, unknown>;

declare const __TIERLESS_ROUTES__: Record<string, string>;   // route pattern -> module id (import key)
declare const __TIERLESS_MODULES__: Record<string, () => Promise<Record<string, (...a: unknown[]) => Promise<unknown>>>>;

const API_ORIGIN = (): string => {
  const u = (window as { API_URL?: string }).API_URL || localStorage.getItem("API_URL") || "";
  try { return new URL(u, location.href).origin; } catch { return ""; }
};

// "/projects/:id/:view" -> matcher extracting ordered params
function matchRoute(pattern: string, path: string): string[] | null {
  const ps = pattern.split("/").filter(Boolean), xs = path.split("/").filter(Boolean);
  if (ps.length !== xs.length) return null;
  const params: string[] = [];
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) params.push(decodeURIComponent(xs[i]));
    else if (ps[i] !== xs[i]) return null;
  }
  return params;
}

/** Normalize a URL's path+query for bundle keying: sorted query params, no trailing slash. */
function normKey(pathAndQuery: string): string {
  const u = new URL(pathAndQuery, "http://x");
  const q = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = q.map(([k, v]) => `${k}=${v}`).join("&");
  return u.pathname.replace(/\/$/, "") + (qs ? "?" + qs : "");
}

const dbg = (...a: unknown[]): void => { if (localStorage.getItem("tierlessDebug")) console.log("[tierless]", ...a); };
let inflight: Promise<Bundle> | null = null;                       // the active route workflow, if any
let inflightUntil = 0;                                             // guard: held XHRs only wait while this is fresh
let inflightKey = "";                                              // dedupe: an SPA redirect (/projects/1 -> /projects/1/1) must not double-run

async function runRoute(path: string): Promise<void> {
  for (const [pattern, moduleId] of Object.entries(__TIERLESS_ROUTES__)) {
    const params = matchRoute(pattern, path);
    if (!params) continue;
    // one workflow run per (module, FULL param vector) within the freshness window: link
    // hrefs and pushState describe the same navigation twice, but sibling routes that
    // differ in a later param (/projects/1/views/2 vs .../views/3) are DIFFERENT
    // navigations — keying on the primary param alone served the first view's data to
    // the second. A router redirect to a deeper default re-runs once; correctness over dedupe.
    const key = moduleId + ":" + params.join("/");
    if (inflight && inflightKey === key && Date.now() < inflightUntil) { dbg("dedupe", path); return; }
    dbg("run", path, params);
    inflightKey = key;
    const load = __TIERLESS_MODULES__[moduleId];
    if (!load) continue;
    inflightUntil = Date.now() + 10_000;
    inflight = (async () => {
      const mod = await load();
      const actions = (mod as { __tierlessActions?: Record<string, (...a: unknown[]) => Promise<unknown>> }).__tierlessActions || {};
      const entry = actions[Object.keys(actions)[0]];
      if (!entry) throw new Error("no tierless action exported by " + moduleId);
      const raw = (await entry(...params)) as Record<string, unknown>;
      const bundle: Bundle = {};
      for (const [k, v] of Object.entries(raw)) bundle[normKey(k)] = v;
      return bundle;
    })().catch((e) => { console.warn("tierless route workflow failed — falling back to the app's own requests", e); return {}; });
    return;
  }
  // an unmatched route leaves the current run alone: SPA routers emit intermediate
  // locations mid-navigation, and nulling here would defeat the dedupe window
}

// ---- navigation hooks -------------------------------------------------------------------
const onNav = (): void => { void runRoute(location.pathname); };
for (const m of ["pushState", "replaceState"] as const) {
  const orig = history[m].bind(history);
  (history as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => { const r = (orig as (...a: unknown[]) => unknown)(...args); onNav(); return r; };
}
addEventListener("popstate", onNav);
// Link clicks arm the workflow BEFORE the router does anything: SPA routers often run
// data-loading guards ahead of pushState, and those fetches must find the hold in place.
addEventListener("click", (e) => {
  const a = (e.target as Element | null)?.closest?.("a[href]");
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if (href.startsWith("/")) void runRoute(new URL(href, location.href).pathname);
}, true);
onNav();                                                           // the initial location counts too

// ---- XHR interception -------------------------------------------------------------------
const RealXHR = XMLHttpRequest;
const OPEN = RealXHR.prototype.open, SEND = RealXHR.prototype.send;

// Interaction-scoped memoization of identical API GETs: the same URL requested N times
// within the window rides ONE network request (the SWR-style dedupe apps accrete ad hoc —
// here the adapter provides it). Replays respect the original response value/contentType.
interface Memo { status: number; headers: string; contentType: string | null; value: unknown }
const memo = new Map<string, { at: number; p: Promise<Memo> }>();
const MEMO_MS = 10_000;

const replay = (xhr: XMLHttpRequest, m: Memo): void => {
  Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
  Object.defineProperty(xhr, "status", { value: m.status, configurable: true });
  Object.defineProperty(xhr, "statusText", { value: m.status === 200 ? "OK" : String(m.status), configurable: true });
  Object.defineProperty(xhr, "response", { value: m.value, configurable: true });
  if (typeof m.value === "string") Object.defineProperty(xhr, "responseText", { value: m.value, configurable: true });
  Object.defineProperty(xhr, "getAllResponseHeaders", { value: () => m.headers, configurable: true });
  Object.defineProperty(xhr, "getResponseHeader", { value: (h: string) => { const rx = new RegExp("^" + h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ": (.*)$", "im"); const g = rx.exec(m.headers); return g ? g[1].trim() : null; }, configurable: true });
  xhr.dispatchEvent(new Event("readystatechange"));
  xhr.dispatchEvent(new ProgressEvent("load"));
  xhr.dispatchEvent(new ProgressEvent("loadend"));
};

// two requests are "identical" only when everything that can change the RESPONSE
// matches: url, the auth material, and the response mode — a URL-only key could hand
// one principal's cached data to another within the freshness window
const memoKey = (xhr: XMLHttpRequest & { __t?: { url: string; auth?: string } }): string =>
  (xhr.__t?.url ?? "") + " " + (xhr.__t?.auth ?? "") + " " + (xhr.responseType || "");

/** Send for real, memoizing the response under the full request key for identical followers. */
const sendMemoized = (xhr: XMLHttpRequest, key: string, body: Document | XMLHttpRequestBodyInit | null): void => {
  memo.set(key, {
    at: Date.now(),
    p: new Promise<Memo>((resolve, reject) => {
      xhr.addEventListener("load", () => resolve({ status: xhr.status, headers: xhr.getAllResponseHeaders(), contentType: xhr.getResponseHeader("content-type"), value: xhr.response }));
      xhr.addEventListener("error", () => { memo.delete(key); reject(new Error("network")); });
      xhr.addEventListener("abort", () => { memo.delete(key); reject(new Error("abort")); });
    }),
  });
  SEND.call(xhr, body);
};

/** Route a GET through the memo: replay a fresh entry, else go to the network as the one
 *  request identical followers will piggyback on. */
const sendViaMemo = (xhr: XMLHttpRequest, key: string, body: Document | XMLHttpRequestBodyInit | null): void => {
  const e = memo.get(key);
  if (e && Date.now() - e.at < MEMO_MS) {
    dbg("memo", key);
    void e.p.then((m) => replay(xhr, m), () => SEND.call(xhr, body));
    return;
  }
  sendMemoized(xhr, key, body);
};

RealXHR.prototype.open = function (this: XMLHttpRequest & { __t?: { method: string; url: string; auth?: string } }, method: string, url: string | URL, ...rest: unknown[]) {
  this.__t = { method: String(method).toUpperCase(), url: String(url) };
  return (OPEN as (...a: unknown[]) => void).call(this, method, url, ...(rest as []));
};

const SET_HEADER = RealXHR.prototype.setRequestHeader;
RealXHR.prototype.setRequestHeader = function (this: XMLHttpRequest & { __t?: { auth?: string } }, name: string, value: string) {
  if (this.__t && name.toLowerCase() === "authorization") this.__t.auth = value;   // auth material is part of request identity (memoKey)
  return SET_HEADER.call(this, name, value);
};

RealXHR.prototype.send = function (this: XMLHttpRequest & { __t?: { method: string; url: string } }, body?: Document | XMLHttpRequestBodyInit | null) {
  const t = this.__t;
  const api = API_ORIGIN();
  // WRITES INVALIDATE: any mutation to the API origin clears the memo and the workflow
  // bundle — a held GET after a POST must see the world the POST made, not a cached one.
  if (t && t.method !== "GET" && t.method !== "OPTIONS" && (t.url.startsWith(api) || t.url.startsWith("/"))) {
    memo.clear(); inflight = null; inflightKey = ""; dbg("invalidate", t.method, t.url);
  }
  const interceptable = t && t.method === "GET" && inflight !== null && Date.now() < inflightUntil &&
    (t.url.startsWith(api) || t.url.startsWith("/"));
  const isApiGet = t && t.method === "GET" && (t.url.startsWith(api) || t.url.startsWith("/"));
  if (!interceptable) {
    if (isApiGet) { dbg("passthrough", t!.url, "inflight=" + (inflight !== null)); return sendViaMemo(this, memoKey(this), body ?? null); }
    return SEND.call(this, body ?? null);
  }

  const abs = new URL(t!.url, location.href);
  const key = normKey(abs.pathname.replace(/^\/api\/v\d+/, (p) => p) + abs.search);   // keys carry the full path incl. /api/vN
  dbg("hold", key);
  void inflight!.then((bundle) => {
    const hit = Object.prototype.hasOwnProperty.call(bundle, key) ? bundle[key] : undefined;
    dbg(hit === undefined ? "miss" : "serve", key, hit === undefined ? Object.keys(bundle) : "");
    if (hit === undefined) return sendViaMemo(this, memoKey(this), body ?? null);   // miss: the real network (deduped), unchanged
    // workflow entries are restResources envelopes ({status, headers, body}) or raw values
    const env: Envelope = hit !== null && typeof hit === "object" && "body" in (hit as object) && ("headers" in (hit as object) || "status" in (hit as object)) ? hit as Envelope : { body: hit };
    const headers: Record<string, string> = { "content-type": "application/json", ...(env.headers || {}) };
    const headerBlock = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n";
    const text = JSON.stringify(env.body);
    Object.defineProperty(this, "readyState", { value: 4, configurable: true });
    Object.defineProperty(this, "status", { value: env.status ?? 200, configurable: true });
    Object.defineProperty(this, "statusText", { value: "OK", configurable: true });
    Object.defineProperty(this, "responseText", { value: text, configurable: true });
    Object.defineProperty(this, "response", { value: text, configurable: true });
    Object.defineProperty(this, "getAllResponseHeaders", { value: () => headerBlock, configurable: true });
    Object.defineProperty(this, "getResponseHeader", { value: (h: string) => headers[h.toLowerCase()] ?? null, configurable: true });
    this.dispatchEvent(new Event("readystatechange"));
    this.dispatchEvent(new ProgressEvent("load"));
    this.dispatchEvent(new ProgressEvent("loadend"));
  });
  return undefined;
};
