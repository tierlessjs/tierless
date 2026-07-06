// Tierless — the browser host, assembled. Two shapes:
//
//   connect({ url?, exec?, bundle? })     one socket to the app's session endpoint.
//     .register(module, bundle)           add a compiled mix-module to this connection
//     .call(entry, args, module?)         start entry(...) on the SERVER; bounces welcome
//     .ready / .close()
//
//   bindActions(bundle, { module, url? }) what compiled "use tierless" modules call: returns
//     { entryName: (...args) => Promise } for every PROGRAM, sharing ONE lazy connection
//     per page no matter how many mix-modules the app imports.
//
// Browser-safe and import-safe under SSR: nothing touches WebSocket/location until the
// first call. `exec` services browser-pinned resources (dom.commit in the full-tierless
// mode, ui.* if you pin some); actions that never touch one simply run out on the server.
import { makeHost, answerWith } from "./host.mjs";
import { makePeer, wsPort, onEvent } from "./transport.mjs";
import { WS_PATH } from "./ws-path.mjs";
import { httpResources } from "./adapt.mjs";
import type { Bundle, Exec, Host } from "./types.mjs";

const defaultUrl = (): string => {
  if (typeof location === "undefined") throw new Error("tierless: no location — pass { url } (or call actions from the browser)");
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + WS_PATH;
};

export interface ConnectOpts {
  url?: string | (() => string);     // thunk: evaluated at CONNECT time, so a session
                                     // token read from storage is current, not page-load stale
  /** Services browser-pinned resources (dom.commit in the full-tierless mode, ui.* if pinned). */
  exec?: Exec;
  bundle?: Bundle;
  tier?: string;
}
export interface Connection {
  ready: Promise<void>;
  register(module: string, bundle: Bundle): Host;
  /** Start entry(...args) on the SERVER; bounces back here are serviced by `exec`. */
  call(entry: string, args?: unknown[], module?: string): Promise<unknown>;
  /** Run entry(...args) HERE; foreign resources are fetched over the session (the frame
   *  never ships — the compiled-class-method path, see bindMethods). localExec serves
   *  requests whose args can't cross (FormData, callbacks) on this tier. */
  runLocal(entry: string, args?: unknown[], module?: string, localExec?: Exec): Promise<unknown>;
  close(): void;
}

export function connect({ url, exec, bundle, tier = "browser" }: ConnectOpts = {}): Connection {
  const ws = new WebSocket((typeof url === "function" ? url() : url) || defaultUrl());
  const peer = makePeer(wsPort(ws));
  const ready: Promise<void> = new Promise((res, rej) => {
    onEvent(ws, "open", () => res());
    onEvent(ws, "error", (e: any) => rej(new Error("tierless: websocket error" + (e && e.message ? ": " + e.message : ""))));
  });

  const hosts = new Map<string, Host>();                          // moduleId -> host
  const register = (module: string, b: Bundle): Host => {
    const id = module || "";
    if (!hosts.has(id)) hosts.set(id, makeHost({ bundle: b, tier, exec: exec as Exec, meta: id ? { module: id } : {} }));   // exec is optional here (actions-only pages never own a resource); makeHost only calls it when one is
    return hosts.get(id)!;
  };
  if (bundle) register("", bundle);
  answerWith(peer, (id) => {
    const h = hosts.get(id || "");
    if (!h) throw new Error("tierless: no bundle registered for module " + JSON.stringify(id));
    return h;
  });

  return {
    ready,
    register,
    call: async (entry: string, args: unknown[] = [], module: string = ""): Promise<unknown> => {
      await ready;
      const h = hosts.get(module || "");
      if (!h) throw new Error("tierless: no bundle registered" + (module ? " for " + module : ""));
      return h.call(peer, entry, args);
    },
    runLocal: async (entry: string, args: unknown[] = [], module: string = "", localExec?: Exec): Promise<unknown> => {
      await ready;
      const h = hosts.get(module || "");
      if (!h) throw new Error("tierless: no bundle registered" + (module ? " for " + module : ""));
      return h.runLocal(peer, entry, args, localExec ? { exec: localExec } : undefined);
    },
    close: () => ws.close(),
  };
}

// ---- the actions surface (what the Vite plugin emits calls into) ----------------------
let sharedOpts: ConnectOpts = {};
let shared: Connection | null = null;
// Optional page-level configuration (url, exec for browser-pinned resources). Call before
// the first action fires; the first bindActions() call materializes the connection.
// preconnect opens the socket NOW, during app bootstrap, instead of lazily inside the
// first action — on a fresh page the TCP+upgrade handshake (~2 RTT) otherwise lands on
// the first navigation's critical path and cancels most of what the migration saves.
export function configureTierless(opts: ConnectOpts & { preconnect?: boolean }): void {
  sharedOpts = opts || {}; shared = null;
  if (opts?.preconnect) sharedConn();
}
const sharedConn = (): Connection => (shared || (shared = connect(sharedOpts)));

export function bindActions(bundle: Bundle, { module = "" }: { module?: string } = {}): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of Object.keys(bundle.PROGRAMS)) {
    out[name] = (...args: unknown[]) => {
      const conn = sharedConn();
      conn.register(module, bundle);
      return conn.call(name, args, module);
    };
  }
  return out;
}

/** Route a compiled module's class-method stubs (real app code — service layers) through
 *  the shared connection. Methods run on the FETCH path: the frame — whose arg 0 is the
 *  live instance, often a framework proxy — stays in the browser and mutates the real
 *  object; only resource requests and results cross. Call once per compiled module. */
export function bindMethods(bundle: Bundle & { __bindTierlessMethods?: (fn: (prog: string, self: unknown, args: unknown[]) => Promise<unknown>) => void }, { module = "" }: { module?: string } = {}): void {
  if (typeof bundle.__bindTierlessMethods !== "function") throw new Error("tierless: bundle has no compiled class methods (rebuild with a compiler that emits __bindTierlessMethods)");
  bundle.__bindTierlessMethods(async (prog, self, args) => {
    const conn = sharedConn();
    conn.register(module, bundle);
    // pinned (unserializable-arg) requests run on the instance's OWN http — the same
    // object the uncompiled method would have used — so uploads with progress callbacks
    // behave stock while everything serializable rides the session
    const own = (self as { http?: Record<string, unknown> } | null)?.http;
    return conn.runLocal(prog, [self, ...args], module, own ? httpResources(own) : undefined);
  });
}
