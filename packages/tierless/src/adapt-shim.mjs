const API_ORIGIN = () => {
    const u = window.API_URL || localStorage.getItem("API_URL") || "";
    try {
        return new URL(u, location.href).origin;
    }
    catch {
        return "";
    }
};
// "/projects/:id/:view" -> matcher extracting ordered params
function matchRoute(pattern, path) {
    const ps = pattern.split("/").filter(Boolean), xs = path.split("/").filter(Boolean);
    if (ps.length !== xs.length)
        return null;
    const params = [];
    for (let i = 0; i < ps.length; i++) {
        if (ps[i].startsWith(":"))
            params.push(decodeURIComponent(xs[i]));
        else if (ps[i] !== xs[i])
            return null;
    }
    return params;
}
/** Normalize a URL's path+query for bundle keying: sorted query params, no trailing slash. */
function normKey(pathAndQuery) {
    const u = new URL(pathAndQuery, "http://x");
    const q = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const qs = q.map(([k, v]) => `${k}=${v}`).join("&");
    return u.pathname.replace(/\/$/, "") + (qs ? "?" + qs : "");
}
const dbg = (...a) => { if (localStorage.getItem("tierlessDebug"))
    console.log("[tierless]", ...a); };
let inflight = null; // the active route workflow, if any
let inflightUntil = 0; // guard: held XHRs only wait while this is fresh
let inflightKey = ""; // dedupe: an SPA redirect (/projects/1 -> /projects/1/1) must not double-run
async function runRoute(path) {
    for (const [pattern, moduleId] of Object.entries(__TIERLESS_ROUTES__)) {
        const params = matchRoute(pattern, path);
        if (!params)
            continue;
        // one workflow run per (module, primary param) within the freshness window: link hrefs,
        // pushState, and router redirects all describe the same navigation in different depths
        const key = moduleId + ":" + params[0];
        if (inflight && inflightKey === key && Date.now() < inflightUntil) {
            dbg("dedupe", path);
            return;
        }
        dbg("run", path, params);
        inflightKey = key;
        const load = __TIERLESS_MODULES__[moduleId];
        if (!load)
            continue;
        inflightUntil = Date.now() + 10_000;
        inflight = (async () => {
            const mod = await load();
            const actions = mod.__tierlessActions || {};
            const entry = actions[Object.keys(actions)[0]];
            if (!entry)
                throw new Error("no tierless action exported by " + moduleId);
            const raw = (await entry(...params));
            const bundle = {};
            for (const [k, v] of Object.entries(raw))
                bundle[normKey(k)] = v;
            return bundle;
        })().catch((e) => { console.warn("tierless route workflow failed — falling back to the app's own requests", e); return {}; });
        return;
    }
    // an unmatched route leaves the current run alone: SPA routers emit intermediate
    // locations mid-navigation, and nulling here would defeat the dedupe window
}
// ---- navigation hooks -------------------------------------------------------------------
const onNav = () => { void runRoute(location.pathname); };
for (const m of ["pushState", "replaceState"]) {
    const orig = history[m].bind(history);
    history[m] = (...args) => { const r = orig(...args); onNav(); return r; };
}
addEventListener("popstate", onNav);
// Link clicks arm the workflow BEFORE the router does anything: SPA routers often run
// data-loading guards ahead of pushState, and those fetches must find the hold in place.
addEventListener("click", (e) => {
    const a = e.target?.closest?.("a[href]");
    if (!a)
        return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("/"))
        void runRoute(new URL(href, location.href).pathname);
}, true);
onNav(); // the initial location counts too
// ---- XHR interception -------------------------------------------------------------------
const RealXHR = XMLHttpRequest;
const OPEN = RealXHR.prototype.open, SEND = RealXHR.prototype.send;
const memo = new Map();
const MEMO_MS = 10_000;
const replay = (xhr, m) => {
    Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
    Object.defineProperty(xhr, "status", { value: m.status, configurable: true });
    Object.defineProperty(xhr, "statusText", { value: m.status === 200 ? "OK" : String(m.status), configurable: true });
    Object.defineProperty(xhr, "response", { value: m.value, configurable: true });
    if (typeof m.value === "string")
        Object.defineProperty(xhr, "responseText", { value: m.value, configurable: true });
    Object.defineProperty(xhr, "getAllResponseHeaders", { value: () => (m.contentType ? `content-type: ${m.contentType}\r\n` : ""), configurable: true });
    Object.defineProperty(xhr, "getResponseHeader", { value: (h) => (h.toLowerCase() === "content-type" ? m.contentType : null), configurable: true });
    xhr.dispatchEvent(new Event("readystatechange"));
    xhr.dispatchEvent(new ProgressEvent("load"));
    xhr.dispatchEvent(new ProgressEvent("loadend"));
};
/** Send for real, memoizing the response under `url` for identical followers. */
const sendMemoized = (xhr, url, body) => {
    memo.set(url, {
        at: Date.now(),
        p: new Promise((resolve, reject) => {
            xhr.addEventListener("load", () => resolve({ status: xhr.status, contentType: xhr.getResponseHeader("content-type"), value: xhr.response }));
            xhr.addEventListener("error", () => { memo.delete(url); reject(new Error("network")); });
            xhr.addEventListener("abort", () => { memo.delete(url); reject(new Error("abort")); });
        }),
    });
    SEND.call(xhr, body);
};
/** Route a GET through the memo: replay a fresh entry, else go to the network as the one
 *  request identical followers will piggyback on. */
const sendViaMemo = (xhr, url, body) => {
    const e = memo.get(url);
    if (e && Date.now() - e.at < MEMO_MS) {
        dbg("memo", url);
        void e.p.then((m) => replay(xhr, m), () => SEND.call(xhr, body));
        return;
    }
    sendMemoized(xhr, url, body);
};
RealXHR.prototype.open = function (method, url, ...rest) {
    this.__t = { method: String(method).toUpperCase(), url: String(url) };
    return OPEN.call(this, method, url, ...rest);
};
RealXHR.prototype.send = function (body) {
    const t = this.__t;
    const api = API_ORIGIN();
    // WRITES INVALIDATE: any mutation to the API origin clears the memo and the workflow
    // bundle — a held GET after a POST must see the world the POST made, not a cached one.
    if (t && t.method !== "GET" && t.method !== "OPTIONS" && (t.url.startsWith(api) || t.url.startsWith("/"))) {
        memo.clear();
        inflight = null;
        inflightKey = "";
        dbg("invalidate", t.method, t.url);
    }
    const interceptable = t && t.method === "GET" && inflight !== null && Date.now() < inflightUntil &&
        (t.url.startsWith(api) || t.url.startsWith("/"));
    const isApiGet = t && t.method === "GET" && (t.url.startsWith(api) || t.url.startsWith("/"));
    if (!interceptable) {
        if (isApiGet) {
            dbg("passthrough", t.url, "inflight=" + (inflight !== null));
            return sendViaMemo(this, t.url, body ?? null);
        }
        return SEND.call(this, body ?? null);
    }
    const abs = new URL(t.url, location.href);
    const key = normKey(abs.pathname.replace(/^\/api\/v\d+/, (p) => p) + abs.search); // keys carry the full path incl. /api/vN
    dbg("hold", key);
    void inflight.then((bundle) => {
        const hit = Object.prototype.hasOwnProperty.call(bundle, key) ? bundle[key] : undefined;
        dbg(hit === undefined ? "miss" : "serve", key, hit === undefined ? Object.keys(bundle) : "");
        if (hit === undefined)
            return sendViaMemo(this, t.url, body ?? null); // miss: the real network (deduped), unchanged
        const text = JSON.stringify(hit);
        Object.defineProperty(this, "readyState", { value: 4, configurable: true });
        Object.defineProperty(this, "status", { value: 200, configurable: true });
        Object.defineProperty(this, "statusText", { value: "OK", configurable: true });
        Object.defineProperty(this, "responseText", { value: text, configurable: true });
        Object.defineProperty(this, "response", { value: text, configurable: true });
        Object.defineProperty(this, "getAllResponseHeaders", { value: () => "content-type: application/json\r\n", configurable: true });
        Object.defineProperty(this, "getResponseHeader", { value: (h) => (h.toLowerCase() === "content-type" ? "application/json" : null), configurable: true });
        this.dispatchEvent(new Event("readystatechange"));
        this.dispatchEvent(new ProgressEvent("load"));
        this.dispatchEvent(new ProgressEvent("loadend"));
    });
    return undefined;
};
export {};
