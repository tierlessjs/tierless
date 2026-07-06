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
import { makeRecorder, type RecorderOpts, type Recorder } from "./trace.mjs";

const isRecorder = (t: RecorderOpts | Recorder): t is Recorder => typeof (t as Recorder).ship === "function";
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
  /** Trace recording (trajectory design §3): head-sampled per run, the flag rides the
   *  continuation itself (F0.__trace), records stream to the sink. Absent = zero cost.
   *  Pass a pre-built Recorder to keep a handle on it (e.g. its `dropped` counter). */
  trace?: RecorderOpts | Recorder;
}

export function makeHost({ bundle, tier, exec, owns, meta = {}, trace }: MakeHostOpts): Host {
  const pump = makePump(bundle);
  const ownsHere: (tier: string) => boolean = owns || ((t) => t === tier);
  const rec: Recorder | null = trace ? (isRecorder(trace) ? trace : makeRecorder(trace)) : null;

  // A traced run measures every resource touch (site + argument features + result size —
  // the ordered sequence the trajectory profile is built from). Only when a recorder is
  // configured does exec get wrapped; the wrapper itself no-ops on untraced stacks.
  const execFor = (stack: Frame[]): Exec => !rec ? exec : async (req) => {
    const v = await exec(req);
    rec.res(stack, req, v);
    return v;
  };
  // A traced stack's flag is captured BEFORE pumping: a finished pump has popped every
  // frame, so the end marker needs the flag held aside. Untraced stacks pump exactly as before.
  const runPump = async (stack: Frame[], incoming: ResourceRequest | null = null): Promise<PumpResult> => {
    const flag = rec ? rec.flagOf(stack) : null;
    const res = await pump(stack, ownsHere, execFor(stack), incoming);
    if (res.done) rec?.end(flag, "done");
    return res;
  };
  // The continuation is about to cross: the recorder bumps the stack-carried counters,
  // encodes, and records the site with the REAL shipped bytes. The shipped host always
  // migrates today; a §6 driver records its actual choice itself.
  const ship = (res: Extract<PumpResult, { done: false }>): Uint8Array =>
    rec ? rec.ship(res.stack, res.request, () => encodeWireBinary(res.stack, res.request), "migrate")
        : encodeWireBinary(res.stack, res.request);

  // Interpret a peer reply: done -> final value; suspend -> pump the migrated stack here
  // (which may end done, or park at another foreign resource for the caller to bounce).
  async function settle({ obj: reply, bin }: { obj: HostReply; bin: Uint8Array | null }): Promise<PumpResult> {
    if (reply.type === "error") throw new Error(reply.message);
    if (reply.type === "done") return { done: true, value: reply.value };
    const { stack, request } = decodeWireBinary(bin!);
    return runPump(stack as Frame[], request as ResourceRequest | null);   // a "suspend" reply's bin always decodes to what the sender's PumpResult shipped — a real continuation stack + ResourceRequest
  }

  // Bounce a local result with the peer until the session completes: every time the
  // continuation parks at a foreign resource, ship it; every time it comes back, pump it.
  async function drive(peer: Peer, res: PumpResult): Promise<unknown> {
    while (!res.done) {
      res = await settle(await peer.request({ type: "resume", ...meta }, ship(res)));
    }
    return res.value;
  }

  // Serve one migrated-in step: pump from where the peer left off, reply done/suspend.
  async function step(stack: Frame[], incoming: ResourceRequest | null): Promise<{ obj: HostReply; bin?: Uint8Array }> {
    const flag = rec ? rec.flagOf(stack) : null;
    try {
      const res = await runPump(stack, incoming);
      if (res.done) return { obj: { type: "done", value: res.value } };
      return { obj: { type: "suspend" }, bin: ship(res) };
    } catch (e: any) {
      rec?.end(flag, "error");
      return { obj: { type: "error", message: String((e && e.message) || e) } };
    }
  }

  const host: Host = {
    pump,
    // Start entry(...args) on THIS tier and drive it to completion with the peer.
    run: async (peer, entry, args = [], opts = {}) => {
      const stack = initialStack(entry, args);
      const id = rec?.spawn(entry, opts.trace);
      if (id) rec!.stamp(stack, id);
      return drive(peer, await runPump(stack));
    },
    // Ask the PEER to start entry(...args) over there; service any bounces back here. The
    // trace decision is made HERE at spawn; no stack exists yet, so the flag rides the
    // start payload for exactly this one message — handleStart stamps it into the root
    // frame it builds, and it is stack-carried thereafter.
    call: async (peer, entry, args = [], opts = {}) => {
      const id = rec?.spawn(entry, opts.trace);
      return drive(peer, await settle(await peer.request({ type: "start", entry, ...(id ? { __trace: id } : {}), ...meta }, encodeArgs(args))));
    },
    // The FETCH arm: the stack stays HERE for the whole run; a park at a foreign resource
    // sends only (name, args) and resumes with the value. Errors re-enter through the
    // pump's service() path, so the compiled code's own try/catch/finally see them. The
    // frame never serializes — compiled class methods (whose arg 0 is a live instance,
    // often a reactive proxy) run on this path, mutating the real object in place.
    // (No trace recording yet: the recorder prices shipped stacks; fetch-hop records land
    // with the §6 decide-loop integration.)
    runLocal: async (peer, entry, args = []) => {
      const stack = initialStack(entry, args);
      let request: ResourceRequest | null = null;
      let carry: { value: unknown } | { error: unknown } | null = null;
      for (;;) {
        const c = carry; carry = null;
        // one-shot exec: the first service() call consumes the fetched result (or throws
        // the fetch error INTO the machine); anything else this tier owns runs normally
        const localExec: Exec = (r) => { if (c) return "error" in c ? (() => { throw c.error; })() : c.value; return exec(r); };
        const res = await pump(stack, ownsHere, localExec, request);
        if (res.done) return res.value;
        const { obj } = await peer.request({ type: "exec", tier: res.request.tier, ...meta }, encodeArgs([res.request.name, res.request.args]));
        request = res.request;
        carry = obj.type === "error" ? { error: new Error(obj.message) } : { value: obj.value };
      }
    },
    // The answering half, exposed as plain handlers so a dispatcher can route by meta.
    handleStart: (payload, bin) => {
      const stack = initialStack(payload.entry, decodeArgs(bin!));
      if (rec && typeof payload.__trace === "string") rec.stamp(stack, payload.__trace);
      return step(stack, null);
    },
    handleResume: (payload, bin) => { const { stack, request } = decodeWireBinary(bin!); return step(stack as Frame[], request as ResourceRequest | null); },
    // Serve one fetched resource for a peer's runLocal: no stack arrives and none returns.
    handleExec: async (payload, bin) => {
      try {
        const [name, rargs] = decodeArgs(bin!) as [string, unknown[]];
        const value = await exec({ op: "resource", tier: payload.tier || tier, name, args: rargs });
        return { obj: { type: "done", value } };
      } catch (e: any) { return { obj: { type: "error", message: String((e && e.message) || e) } }; }
    },
    // Convenience: answer starts/resumes on a peer when this host is the only one on it.
    answer(peer) { peer.on("start", host.handleStart); peer.on("resume", host.handleResume); peer.on("exec", host.handleExec); return host; },
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
  peer.on("exec", async (p, bin) => (await pick(p)).handleExec(p, bin));
}
