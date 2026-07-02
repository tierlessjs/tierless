// The TRUSTED side — a separate application your Stackmix program can only call.
// server.mjs forks this module as a reference-monitor sidecar (its own OS process): the
// host holds a pipe and a session token, never this code, never the data. Every call is
// re-authorized here against the verified principal.
//
// Pre-ship check: npm run check:api   (an endpoint without authorize fails at load time)
import { defineApi, PUBLIC, sidecarMain } from "stackmix/api";

const NOTES = ["Welcome to Stackmix.", "This list lives behind the monitor."];

export const service = defineApi((api) => ({
  // PUBLIC login mints the session token INSIDE this process; the secret never leaves.
  login: { authorize: PUBLIC, run: ([c]) => {
    if (!c || c.pass !== "demo") throw new Error("bad credentials");
    return api.issue({ sub: c.user }, 3600);
  } },

  // Reads are open; writes need an authenticated principal with checked args.
  list: { authorize: PUBLIC, run: () => NOTES.slice() },
  add: { authorize: (p, [text]) => p != null && typeof text === "string" && text.trim().length > 0,
    run: ([text], p) => { NOTES.push(`${text.trim()} — ${p.sub}`); return NOTES.length; } },
}), { maxArgsBytes: 8 * 1024, rate: { max: 300, windowMs: 10_000 } });

sidecarMain(service);
