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
import { makeCoherence } from "./coherence.mjs";
import { makePeer, wsPort, onEvent } from "./transport.mjs";
import { WS_PATH } from "./ws-path.mjs";
import { httpResources, httpPins, crossHttpRequest } from "./adapt.mjs";
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
  /** §5 heap coherence (deref a server-owned handle over the socket, write a mutation back
   *  under CAS, serve browser-owned handles). On by default; it takes effect per module —
   *  only --auto-deref/--auto-writeback bundles excise and service §5 ops, so ordinary
   *  bundles are unaffected. false disables it entirely. */
  heap?: boolean;
}
export interface Connection {
  ready: Promise<void>;
  register(module: string, bundle: Bundle): Host;
  /** Start entry(...args) on the SERVER; bounces back here are serviced by `exec`. */
  call(entry: string, args?: unknown[], module?: string): Promise<unknown>;
  /** Run entry(...args) HERE; foreign resources are fetched over the session (the frame
   *  never ships — the compiled-class-method path, see bindMethods). opts.exec serves
   *  pinned requests on this tier; opts.pins adds the resource family's declared pins. */
  runLocal(entry: string, args?: unknown[], module?: string, opts?: { exec?: Exec; pins?: (req: import("./types.mjs").ResourceRequest) => boolean; map?: (req: import("./types.mjs").ResourceRequest) => import("./types.mjs").ResourceRequest | null; migrate?: (req: import("./types.mjs").ResourceRequest, site: { fn: string; pc: number }) => boolean }): Promise<unknown>;
  close(): void;
}

export function connect({ url, exec, bundle, tier = "browser", heap = true }: ConnectOpts = {}): Connection {
  const ws = new WebSocket((typeof url === "function" ? url() : url) || defaultUrl());
  const peer = makePeer(wsPort(ws));
  const ready: Promise<void> = new Promise((res, rej) => {
    onEvent(ws, "open", () => res());
    onEvent(ws, "error", (e: any) => rej(new Error("tierless: websocket error" + (e && e.message ? ": " + e.message : ""))));
  });

  // §5 heap coherence for this connection, shared by every module-host on it (each host
  // applies it only if its own bundle is heap-compiled). serve() lets the server fetch
  // browser-owned handles back, receive write-backs, and release finished continuations.
  const coherence = heap ? makeCoherence(tier) : undefined;
  if (coherence) coherence.serve(peer);

  const hosts = new Map<string, Host>();                          // moduleId -> host
  const register = (module: string, b: Bundle): Host => {
    const id = module || "";
    if (!hosts.has(id)) hosts.set(id, makeHost({ bundle: b, tier, exec: exec as Exec, meta: id ? { module: id } : {}, coherence }));   // exec is optional here (actions-only pages never own a resource); makeHost only calls it when one is
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
    runLocal: async (entry: string, args: unknown[] = [], module: string = "", opts?: { exec?: Exec; pins?: (req: import("./types.mjs").ResourceRequest) => boolean; map?: (req: import("./types.mjs").ResourceRequest) => import("./types.mjs").ResourceRequest | null; migrate?: (req: import("./types.mjs").ResourceRequest, site: { fn: string; pc: number }) => boolean }): Promise<unknown> => {
      await ready;
      const h = hosts.get(module || "");
      if (!h) throw new Error("tierless: no bundle registered" + (module ? " for " + module : ""));
      return h.runLocal(peer, entry, args, opts);
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
export function bindMethods(bundle: Bundle & { __bindTierlessMethods?: (fn: (prog: string, self: unknown, args: unknown[]) => Promise<unknown>) => void }, { module = "", migrate }: { module?: string; migrate?: (req: import("./types.mjs").ResourceRequest, site: { fn: string; pc: number }) => boolean } = {}): void {
  if (typeof bundle.__bindTierlessMethods !== "function") throw new Error("tierless: bundle has no compiled class methods (rebuild with a compiler that emits __bindTierlessMethods)");
  bundle.__bindTierlessMethods(async (prog, self, args) => {
    const conn = sharedConn();
    conn.register(module, bundle);
    // pinned requests (declared: blob/stream responses; owned values: callbacks,
    // FormData) run on the instance's OWN http — the same object the uncompiled method
    // would have used — so uploads and downloads behave stock. Crossing requests are
    // prepared by crossHttpRequest: the instance's request-interceptor chain (app code —
    // auth headers, model→DTO transforms, casing) runs HERE, and the post-chain wire
    // config crosses — exactly what axios would hand its adapter. An async chain
    // returns null and the request pins to the instance instead.
    const own = (self as { http?: Record<string, unknown> } | null)?.http;
    return conn.runLocal(prog, [self, ...args], module, {
      pins: httpPins,
      map: (req) => crossHttpRequest(own as Parameters<typeof crossHttpRequest>[0], req),
      ...(own ? { exec: httpResources(own) } : {}),
      ...(migrate ? { migrate } : {}),   // §6: opt a park into the migrate arm (docs/migrate-arm.md); absent = fetch arm
    });
  });
}
