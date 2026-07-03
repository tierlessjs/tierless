// Tierless — the session host. One small, browser-safe core that assembles the pieces
// every tier needs to carry live continuations: the pump (runtime.mjs), the binary wire
// (wire-binary.mjs), and the peer RPC (transport.mjs). Both tiers use the SAME host —
// only `tier` and `exec` differ — and the protocol is symmetric, so a session started on
// either side bounces freely between them.
//
// Protocol (all payloads may carry extra routing fields via `meta`, e.g. { module }):
//   → { type: "start", entry, ...meta }  bin: wire([], { args })     start entry(...args) HERE
//   → { type: "resume", ...meta }        bin: wire(stack, request)   continue this stack HERE
//   ← { type: "done", value } | { type: "suspend" } + bin | { type: "error", message }
//
// The host is STATELESS per message — the continuation carries all session state — so any
// number of sessions can be in flight on one peer concurrently; the transport's
// correlation ids keep their bounces apart.
import { makePump, initialStack } from "./runtime.mjs";
import { encodeWireBinary, decodeWireBinary } from "./wire-binary.mjs";
import type { Bundle, Frame, Exec, ResourceRequest, Peer, Host, HostReply, Pump } from "./types.mjs";

export type { Bundle, Frame, MachineResult, ResourceRequest, Exec, Peer, Host } from "./types.mjs";

// What settle()/step() work with — the value a Pump's promise resolves to. Named here so
// it isn't spelled out three times.
type PumpResult = Awaited<ReturnType<Pump>>;

export interface MakeHostOpts {
  bundle: Bundle;
  tier: string;
  exec: Exec;
  owns?: (tier: string) => boolean;
  meta?: Record<string, unknown>;
}

export function makeHost({ bundle, tier, exec, owns, meta = {} }: MakeHostOpts): Host {
  const pump = makePump(bundle);
  const ownsHere: (tier: string) => boolean = owns || ((t) => t === tier);

  // Interpret a peer reply: done -> final value; suspend -> pump the migrated stack here
  // (which may end done, or park at another foreign resource for the caller to bounce).
  async function settle({ obj: reply, bin }: { obj: HostReply; bin: Uint8Array | null }): Promise<PumpResult> {
    if (reply.type === "error") throw new Error(reply.message);
    if (reply.type === "done") return { done: true, value: reply.value };
    const { stack, request } = decodeWireBinary(bin!);
    return pump(stack as Frame[], ownsHere, exec, request as ResourceRequest | null);   // a "suspend" reply's bin always decodes to what the sender's PumpResult shipped — a real continuation stack + ResourceRequest
  }

  // Bounce a local result with the peer until the session completes: every time the
  // continuation parks at a foreign resource, ship it; every time it comes back, pump it.
  async function drive(peer: Peer, res: PumpResult): Promise<unknown> {
    while (!res.done) {
      res = await settle(await peer.request({ type: "resume", ...meta }, encodeWireBinary(res.stack, res.request)));
    }
    return res.value;
  }

  // Serve one migrated-in step: pump from where the peer left off, reply done/suspend.
  async function step(stack: Frame[], incoming: ResourceRequest | null): Promise<{ obj: HostReply; bin?: Uint8Array }> {
    try {
      const res = await pump(stack, ownsHere, exec, incoming);
      if (res.done) return { obj: { type: "done", value: res.value } };
      return { obj: { type: "suspend" }, bin: encodeWireBinary(res.stack, res.request) };
    } catch (e: any) {
      return { obj: { type: "error", message: String((e && e.message) || e) } };
    }
  }

  const host: Host = {
    pump,
    // Start entry(...args) on THIS tier and drive it to completion with the peer.
    run: async (peer, entry, args = []) => drive(peer, await pump(initialStack(entry, args), ownsHere, exec)),
    // Ask the PEER to start entry(...args) over there; service any bounces back here.
    call: async (peer, entry, args = []) =>
      drive(peer, await settle(await peer.request({ type: "start", entry, ...meta }, encodeWireBinary([], { op: "start", tier: "", name: "", args })))),
    // The answering half, exposed as plain handlers so a dispatcher can route by meta.
    handleStart: (payload, bin) => step(initialStack(payload.entry, decodeWireBinary(bin!).request!.args), null),
    handleResume: (payload, bin) => { const { stack, request } = decodeWireBinary(bin!); return step(stack as Frame[], request as ResourceRequest | null); },
    // Convenience: answer starts/resumes on a peer when this host is the only one on it.
    answer(peer) { peer.on("start", host.handleStart); peer.on("resume", host.handleResume); return host; },
  };
  return host;
}

// Route peer messages to one of several hosts by a payload field (default "module") —
// used when several compiled modules share one socket (the Vite integration): each
// mix-module's host stamps its id into `meta`, and the other side dispatches on it.
export function answerWith(peer: Peer, hostFor: (id: string) => Host | Promise<Host>, field: string = "module"): void {
  const pick = async (payload: any): Promise<Host> => hostFor((payload && payload[field]) || "");
  peer.on("start", async (p, bin) => (await pick(p)).handleStart(p, bin));
  peer.on("resume", async (p, bin) => (await pick(p)).handleResume(p, bin));
}
