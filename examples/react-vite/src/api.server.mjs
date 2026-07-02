// The TRUSTED side — a separate application the Stackmix program can only call. The Vite
// plugin forks this module as a reference-monitor sidecar (its own OS process): the dev
// server holds a pipe and a session token, never this code, never the data. Every call is
// re-authorized here against the verified principal — a forged/replayed continuation
// reaching placeOrder without a valid token is denied, whatever path it took.
import { defineApi, PUBLIC } from "stackmix/api";
import { sidecarMain } from "stackmix/api";

const QUOTES = { AAPL: 227.5, MSFT: 415.2, NVDA: 138.8, AMZN: 205.7, GOOG: 178.4 };
const ORDERS = [];

export const def = defineApi((api) => ({
  // PUBLIC login mints the session token inside this process; the secret never leaves.
  login: { authorize: PUBLIC, run: ([c]) => {
    if (!c || c.pass !== "demo") throw new Error("bad credentials");
    return api.issue({ sub: c.user }, 3600);
  } },

  // Market data: deliberately public.
  getQuote: { authorize: PUBLIC, run: ([sym]) => {
    const px = QUOTES[sym];
    if (px == null) throw new Error("unknown symbol " + sym);
    return px * (1 + (Math.random() - 0.5) * 0.02);              // a live-ish price
  } },

  // Trading: authenticated principals only, args checked per call.
  placeOrder: { authorize: (p, [o]) => p != null && o && typeof o.sym === "string" && typeof o.qty === "number",
    run: ([o], p) => { const rec = { ...o, by: p.sub, at: Date.now() }; ORDERS.push(rec); return rec; } },
}), { maxArgsBytes: 8 * 1024, rate: { max: 300, windowMs: 10_000 } });

sidecarMain(def);
