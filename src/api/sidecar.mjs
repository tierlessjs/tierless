// The api runs in its OWN OS process. The backend client reaches it by RPC — and we implement that
// RPC as a LOCAL PIPE (the fork IPC channel, a Unix socketpair) rather than a network socket, so a
// chained api call costs a cheap same-host hop instead of a round trip. Co-location buys LATENCY; the
// process boundary IS the trust boundary. The untrusted backend client is handed only a SidecarClient:
// it can post { name, args, token } and read back { ok, value|error }, and nothing else — not the api's
// memory, not its signing secret, not its fn registry.
//
// Why this is the right shape for Stackmix: a browser→backend api call is "migrate the continuation one
// socket hop to the backend client, then RPC one pipe hop to the api." The pipe hop is ~free next to the
// network hop, so the total still reads as a single api round trip — the same cost a traditional
// client→server call would pay — while the trust boundary sits exactly where it belongs.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// Child side. Drive an Api instance from calls arriving on the pipe; reply on the same pipe. Runs in
// the forked process, where the Api and its secret live and never leave. Each message is { id, call };
// each reply is { id, res }.
export function serve(api) {
  if (!process.send) throw new Error("serve(): not running as a forked sidecar (no IPC channel)");
  process.on("message", async (msg) => {
    if (!msg || typeof msg.id !== "number") return;
    let res;
    try { res = await api.handle(msg.call); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }  // never crash the monitor on one bad call
    process.send({ id: msg.id, res });
  });
  process.send({ ready: true });
}

// Parent (untrusted backend client) side. Fork the api module as a sidecar and return a client that
// correlates each call to its reply by id over the pipe. The secret is provisioned to the child by a
// trusted channel the client is not part of — here the child mints its own (server-fns.mjs), so the
// parent never sees it.
export function startSidecar(entryUrl, env = {}) {
  const child = fork(fileURLToPath(entryUrl), [], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: { ...process.env, STACKMIX_SIDECAR: "1", ...env },
  });
  let nextId = 1;
  const pending = new Map();
  let markReady;
  const readyP = new Promise((r) => { markReady = r; });
  child.on("message", (msg) => {
    if (msg && msg.ready) { markReady(); return; }
    if (!msg || typeof msg.id !== "number") return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    p.resolve(msg.res);
  });
  child.on("exit", () => { for (const p of pending.values()) p.reject(new Error("sidecar exited")); pending.clear(); });
  return {
    ready: () => readyP,
    // The ENTIRE surface the untrusted client gets: post a call, await the monitor's verdict.
    call: (name, args = [], token = null) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.send({ id, call: { name, args, token } });
    }),
    close: () => child.kill(),
  };
}

// The pump-side adapter — the DEFAULT way the backend client services the "server" tier.
// Wraps a sidecar client (or anything with the same { call } contract — the transport is
// pluggable; an HTTPS monitor is the same adapter) as an `execHere` for pump(): forward
// { name, args, token }, return the value, and surface a monitor denial as a THROW so it
// unwinds into the continuation and a try/catch in the app catches it across the tier.
// The token is the session's verified-principal bearer; the client holds nothing more.
export function makeApiExec(client, token = null) {
  return async (req) => {
    if (!req.name.startsWith("api.")) throw new Error("backend client can't service " + req.name);
    const res = await client.call(req.name.slice(4), req.args, token);   // "api.getTasks" → monitor fn "getTasks"
    if (!res.ok) throw new Error(res.error);                             // denial/error → catchable throw across the tier
    return res.value;
  };
}
