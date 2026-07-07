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
import { encodeWireBinary, decodeWireBinary, encodeArgs, decodeArgs } from "./wire-binary.mjs";
import type { EncodeOptions } from "./graph.mjs";
import { DEREF_TIER, usesHeap, type Coherence } from "./coherence.mjs";
import type { Bundle, Frame, Exec, ResourceRequest, Peer, Host, HostReply, Pump } from "./types.mjs";

export type { Bundle, Frame, MachineResult, ResourceRequest, Exec, Peer, Host } from "./types.mjs";
export type { Coherence } from "./coherence.mjs";

// What settle()/step() work with — the value a Pump's promise resolves to. Named here so
// it isn't spelled out three times.
type PumpResult = Awaited<ReturnType<Pump>>;

export interface MakeHostOpts {
  bundle: Bundle;
  tier: string;
  exec: Exec;
  owns?: (tier: string) => boolean;
  meta?: Record<string, unknown>;
  /** §5 heap coherence for this connection (excision, deref and CAS write-back over the
   *  socket, bounded cache). Applied PER BUNDLE: it takes effect only when this host's
   *  bundle was compiled for the heap (--auto-deref/--auto-writeback — excision without
   *  the compiled guards would hand the machine a handle where it expects data), so the
   *  same connection-wide coherence can be passed to every module-host on a socket and
   *  only the heap-compiled ones excise and service §5 ops. */
  coherence?: Coherence;
}

let nextSid = 1;

export function makeHost({ bundle, tier, exec, owns, meta = {}, coherence: coherenceIn }: MakeHostOpts): Host {
  const pump = makePump(bundle);
  const coherence = coherenceIn && usesHeap(bundle) ? coherenceIn : undefined;   // per-bundle gate (see MakeHostOpts.coherence)
  const ownsBase: (tier: string) => boolean = owns || ((t) => t === tier);
  // The host also owns the heap pseudo-tiers ("@deref"/"@writeback"): a handle read or a
  // mutation's propagation is serviced HERE (this tier), never migrated.
  const ownsHere: (tier: string) => boolean = coherence ? ((t) => ownsBase(t) || coherence.owns(t)) : ownsBase;
  const encOpts = (sid: string): EncodeOptions => (coherence ? coherence.encodeOpts(sid) : {});
  // The exec the pump runs, bound to the peer the current message rides: an "@deref" is a
  // coherent fetch back over `peer` on a cache miss; an "@writeback" proposes the mutated
  // snapshot to its owner over `peer` under an optimistic CAS. Every other owned resource
  // goes to the app exec. With no coherence this is just the app exec.
  const execOn: (peer: Peer | undefined) => Exec = coherence
    ? (peer) => (req) => (coherence.owns(req.tier)
        ? (req.tier === DEREF_TIER ? coherence.deref(peer as Peer, req.args[0]) : coherence.writeBack(peer as Peer, req.args[0]))
        : exec(req))
    : () => exec;

  // Interpret a peer reply: done -> final value; suspend -> pump the migrated stack here
  // (which may end done, or park at another foreign resource for the caller to bounce).
  async function settle(peer: Peer, { obj: reply, bin }: { obj: HostReply; bin: Uint8Array | null }): Promise<PumpResult> {
    if (reply.type === "error") throw new Error(reply.message);
    if (reply.type === "done") return { done: true, value: reply.value };
    const { stack, request } = decodeWireBinary(bin!);
    return pump(stack as Frame[], ownsHere, execOn(peer), request as ResourceRequest | null);   // a "suspend" reply's bin always decodes to what the sender's PumpResult shipped — a real continuation stack + ResourceRequest
  }

  // Bounce a local result with the peer until the session completes: every time the
  // continuation parks at a foreign resource, ship it; every time it comes back, pump it.
  // `sid` names this continuation on both sides: every §5 local it excises (here and on
  // the answering side, which reads sid from the payload) is tagged with it, and released
  // when the drive settles — the owner heap stays flat across sequential sessions instead
  // of accumulating every session's excisions until disconnect.
  async function drive(peer: Peer, sid: string, res: PumpResult): Promise<unknown> {
    while (!res.done) {
      res = await settle(peer, await peer.request({ type: "resume", sid, ...meta }, encodeWireBinary(res.stack, res.request, encOpts(sid))));
    }
    return res.value;
  }

  // A continuation settled (value or error): free the §5 masters it excised, on both sides.
  const finish = (peer: Peer, sid: string): void => {
    if (coherence) { coherence.release(sid); coherence.releaseRemote(peer, sid); }
  };

  // Serve one migrated-in step: pump from where the peer left off, reply done/suspend.
  // `peer` is the socket the step arrived on — §5 derefs/write-backs go back over it; the
  // payload's sid tags any locals this step excises, released by the starter's completion.
  async function step(peer: Peer | undefined, sid: string, stack: Frame[], incoming: ResourceRequest | null): Promise<{ obj: HostReply; bin?: Uint8Array }> {
    try {
      const res = await pump(stack, ownsHere, execOn(peer), incoming);
      if (res.done) return { obj: { type: "done", value: res.value } };
      return { obj: { type: "suspend" }, bin: encodeWireBinary(res.stack, res.request, encOpts(sid)) };
    } catch (e: any) {
      return { obj: { type: "error", message: String((e && e.message) || e) } };
    }
  }

  const newSid = (): string => tier + "#" + nextSid++;   // starter-side unique; tiers differ, so two starters on one socket can't collide

  const host: Host = {
    pump,
    // Start entry(...args) on THIS tier and drive it to completion with the peer.
    run: async (peer, entry, args = []) => {
      const sid = newSid();
      try { return await drive(peer, sid, await pump(initialStack(entry, args), ownsHere, execOn(peer))); }
      finally { finish(peer, sid); }
    },
    // Ask the PEER to start entry(...args) over there; service any bounces back here.
    call: async (peer, entry, args = []) => {
      const sid = newSid();
      try { return await drive(peer, sid, await settle(peer, await peer.request({ type: "start", entry, sid, ...meta }, encodeArgs(args)))); }
      finally { finish(peer, sid); }
    },
    // The answering half, exposed as plain handlers so a dispatcher can route by meta.
    // A missing payload sid (an older peer) falls back to the connection-lifetime scope "".
    handleStart: (payload, bin, peer) => step(peer, (payload && payload.sid) || "", initialStack(payload.entry, decodeArgs(bin!)), null),
    handleResume: (payload, bin, peer) => { const { stack, request } = decodeWireBinary(bin!); return step(peer, (payload && payload.sid) || "", stack as Frame[], request as ResourceRequest | null); },
    // Convenience: answer starts/resumes on a peer when this host is the only one on it —
    // and serve this connection's §5 heap so the other tier can fetch its handles back.
    answer(peer) {
      peer.on("start", (p, bin) => host.handleStart(p, bin, peer));
      peer.on("resume", (p, bin) => host.handleResume(p, bin, peer));
      if (coherence) coherence.serve(peer);
      return host;
    },
  };
  return host;
}

// Route peer messages to one of several hosts by a payload field (default "module") —
// used when several compiled modules share one socket (the Vite integration): each
// mix-module's host stamps its id into `meta`, and the other side dispatches on it.
export function answerWith(peer: Peer, hostFor: (id: string) => Host | Promise<Host>, field: string = "module"): void {
  const pick = async (payload: any): Promise<Host> => hostFor((payload && payload[field]) || "");
  peer.on("start", async (p, bin) => (await pick(p)).handleStart(p, bin, peer));   // thread the peer so a §5 deref can fetch back over it
  peer.on("resume", async (p, bin) => (await pick(p)).handleResume(p, bin, peer));
}
