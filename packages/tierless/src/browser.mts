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
import { makeCoherence, usesHeap, type Coherence } from "./coherence.mjs";
import { makePeer, wsPort, onEvent } from "./transport.mjs";
import { WS_PATH } from "./ws-path.mjs";
import type { Bundle, Exec, Host } from "./types.mjs";

const defaultUrl = (): string => {
  if (typeof location === "undefined") throw new Error("tierless: no location — pass { url } (or call actions from the browser)");
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + WS_PATH;
};

export interface ConnectOpts {
  url?: string;
  /** Services browser-pinned resources (dom.commit in the full-tierless mode, ui.* if pinned). */
  exec?: Exec;
  bundle?: Bundle;
  tier?: string;
  /** Enable §5 heap coherence (deref a server-owned handle over the socket, write a
   *  mutation back under CAS, serve browser-owned handles). Defaults on for
   *  --auto-deref/--auto-writeback bundles, off otherwise. */
  heap?: boolean;
}
export interface Connection {
  ready: Promise<void>;
  register(module: string, bundle: Bundle): Host;
  /** Start entry(...args) on the SERVER; bounces back here are serviced by `exec`. */
  call(entry: string, args?: unknown[], module?: string): Promise<unknown>;
  close(): void;
}

export function connect({ url, exec, bundle, tier = "browser", heap }: ConnectOpts = {}): Connection {
  const ws = new WebSocket(url || defaultUrl());
  const peer = makePeer(wsPort(ws));
  const ready: Promise<void> = new Promise((res, rej) => {
    onEvent(ws, "open", () => res());
    onEvent(ws, "error", (e: any) => rej(new Error("tierless: websocket error" + (e && e.message ? ": " + e.message : ""))));
  });

  // §5 heap coherence for this connection, created once the first heap-using bundle is
  // known (or if opted in). serve() lets the server fetch browser-owned handles back.
  let coherence: Coherence | undefined;
  const enableCoherence = (b?: Bundle): void => {
    if (coherence) return;
    if (heap ?? (b ? usesHeap(b) : false)) { coherence = makeCoherence(tier); coherence.serve(peer); }
  };
  enableCoherence(bundle);

  const hosts = new Map<string, Host>();                          // moduleId -> host
  const register = (module: string, b: Bundle): Host => {
    const id = module || "";
    if (!hosts.has(id)) { enableCoherence(b); hosts.set(id, makeHost({ bundle: b, tier, exec: exec as Exec, meta: id ? { module: id } : {}, coherence })); }   // exec is optional here (actions-only pages never own a resource); makeHost only calls it when one is
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
    close: () => ws.close(),
  };
}

// ---- the actions surface (what the Vite plugin emits calls into) ----------------------
let sharedOpts: ConnectOpts = {};
let shared: Connection | null = null;
// Optional page-level configuration (url, exec for browser-pinned resources). Call before
// the first action fires; the first bindActions() call materializes the connection.
export function configureTierless(opts: ConnectOpts): void { sharedOpts = opts || {}; shared = null; }
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
