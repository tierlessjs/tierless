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
import { DEREF_TIER, usesHeap, type Coherence } from "./coherence.mjs";
import type { EncodeOptions } from "./graph.mjs";
import type { Bundle, Frame, Exec, ResourceRequest, PumpRequest, Peer, Host, HostReply, Pump } from "./types.mjs";

const isRecorder = (t: RecorderOpts | Recorder): t is Recorder => typeof (t as Recorder).ship === "function";

export type { Bundle, Frame, MachineResult, ResourceRequest, HomePark, PumpRequest, Exec, Peer, Host } from "./types.mjs";
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
  /** Trace recording (trajectory design §3): head-sampled per run, the flag rides the
   *  continuation itself (F0.__trace), records stream to the sink. Absent = zero cost.
   *  Pass a pre-built Recorder to keep a handle on it (e.g. its `dropped` counter). */
  trace?: RecorderOpts | Recorder;
  /** §5 heap coherence for this connection (excision, deref and CAS write-back over the
   *  socket, bounded cache). Applied PER BUNDLE: it takes effect only when this host's
   *  bundle was compiled for the heap (--auto-deref/--auto-writeback — excision without
   *  the compiled guards would hand the machine a handle where it expects data), so the
   *  same connection-wide coherence can be passed to every module-host on a socket and
   *  only the heap-compiled ones excise and service §5 ops. */
  coherence?: Coherence;
  /** Session twin registry for dynamic call parks (docs/migrate-arm.md slice 3):
   *  class-stamped handles resolve to LOCAL instances here. Opt-in per class. */
  twins?: (cls: string) => object | undefined;
}

// OWNERSHIP scan — the generic half of request pinning (a resource family adds its
// declared pins via opts.pins, e.g. axios's responseType:"blob"). A request is pinned
// when its args close over values whose identity or effects belong to THIS tier:
// functions (their effect lives in this heap), host objects (FormData/Blob wrap this
// tier's memory). Plain data — INCLUDING prototyped model instances, which axios itself
// would JSON-serialize — crosses structurally, exactly as it would have gone on the
// wire anyway. NOT a serializability test: that is a codec capability, changes with the
// codec, and can't see semantic pins at all. Depth-limited: pathological values pin
// (fail closed), never hang.
function ownsValues(v: unknown, depth = 0): boolean {
  if (depth > 6) return true;
  if (v === null || v === undefined) return false;
  const t = typeof v;
  if (t === "function" || t === "symbol") return true;
  if (t !== "object") return false;
  if (typeof FormData !== "undefined" && v instanceof FormData) return true;
  if (typeof Blob !== "undefined" && v instanceof Blob) return true;
  if (v instanceof Date || v instanceof Uint8Array) return false;
  if (Array.isArray(v)) return v.some((x) => ownsValues(x, depth + 1));
  return Object.values(v as object).some((x) => ownsValues(x, depth + 1));   // own enumerable props — what crosses; prototypes stay home like axios's JSON pass
}

// The migrate arm's §5 excision predicate (docs/migrate-arm.md): consulted per VALUE while
// the codec walks a shipping stack. Containers return false — the walk descends and each
// element decides for itself — so one owned element doesn't park a whole args array.
// Prototyped instances excise as units even when their data would serialize: crossing
// structurally would hand back a prototype-stripped copy, and a later segment that touches
// the slot must see the SAME object (the stop rule guarantees that touch happens at home).
function ownedUnit(v: unknown): boolean {
  if (typeof v === "function") return true;
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v) || v instanceof Map || v instanceof Set) return false;
  if (v instanceof Date || v instanceof Uint8Array) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return true;
  return ownsValues(v);
}

let nextSid = 1;

export function makeHost({ bundle, tier, exec, owns, meta = {}, trace, coherence: coherenceIn, twins }: MakeHostOpts): Host {
  const pump = makePump(bundle, { twins });
  const coherence = coherenceIn && usesHeap(bundle) ? coherenceIn : undefined;   // per-bundle gate (see MakeHostOpts.coherence)
  const ownsBase: (tier: string) => boolean = owns || ((t) => t === tier);
  // The host also owns the heap pseudo-tiers ("@deref"/"@writeback"): a handle read or a
  // mutation's propagation is serviced HERE (this tier), never migrated.
  const ownsHere: (tier: string) => boolean = coherence ? ((t) => ownsBase(t) || coherence.owns(t)) : ownsBase;
  const encOpts = (sid: string): EncodeOptions => (coherence ? coherence.encodeOpts(sid) : {});
  const rec: Recorder | null = trace ? (isRecorder(trace) ? trace : makeRecorder(trace)) : null;

  // The exec the pump runs, bound to the peer the current message rides: an "@deref" is a
  // coherent fetch back over `peer` on a cache miss; an "@writeback" proposes the mutated
  // snapshot to its owner over `peer` under an optimistic CAS. Every other owned resource
  // goes to the app exec. With no coherence this is just the app exec.
  const execOn: (peer: Peer | undefined) => Exec = coherence
    ? (peer) => (req) => (coherence.owns(req.tier)
        ? (req.tier === DEREF_TIER ? coherence.deref(peer as Peer, req.args[0]) : coherence.writeBack(peer as Peer, req.args[0]))
        : exec(req))
    : () => exec;

  // A traced run measures every resource touch (site + argument features + result size —
  // the ordered sequence the trajectory profile is built from). Only when a recorder is
  // configured does the exec get wrapped; the wrapper itself no-ops on untraced stacks.
  const execFor = (peer: Peer | undefined, stack: Frame[]): Exec => {
    const base = execOn(peer);
    return !rec ? base : async (req) => { const v = await base(req); rec.res(stack, req, v); return v; };
  };
  // A traced stack's flag is captured BEFORE pumping: a finished pump has popped every
  // frame, so the end marker needs the flag held aside. Untraced stacks pump exactly as before.
  const runPump = async (peer: Peer | undefined, stack: Frame[], incoming: ResourceRequest | null = null, sink?: { twinDelta(d: import("./types.mjs").TwinDelta): void }): Promise<PumpResult> => {
    const flag = rec ? rec.flagOf(stack) : null;
    const res = await pump(stack, ownsHere, execFor(peer, stack), incoming, sink);
    if (res.done) rec?.end(flag, "done");
    return res;
  };
  // The continuation is about to cross: the recorder bumps the stack-carried counters,
  // encodes, and records the site with the REAL shipped bytes. The shipped host always
  // migrates today; a §6 driver records its actual choice itself.
  const ship = (sid: string, res: Extract<PumpResult, { done: false }>): Uint8Array =>
    rec ? rec.ship(res.stack, res.request, () => encodeWireBinary(res.stack, res.request, encOpts(sid)), "migrate")
        : encodeWireBinary(res.stack, res.request, encOpts(sid));

  // Interpret a peer reply: done -> final value; suspend -> pump the migrated stack here
  // (which may end done, or park at another foreign resource for the caller to bounce).
  async function settle(peer: Peer, { obj: reply, bin }: { obj: HostReply; bin: Uint8Array | null }): Promise<PumpResult> {
    if (reply.type === "error") throw new Error(reply.message);
    if (reply.type === "done") return { done: true, value: reply.value };
    const { stack, request } = decodeWireBinary(bin!);
    return runPump(peer, stack as Frame[], request as ResourceRequest | null);   // a "suspend" reply's bin always decodes to what the sender's PumpResult shipped — a real continuation stack + ResourceRequest
  }

  // Bounce a local result with the peer until the session completes: every time the
  // continuation parks at a foreign resource, ship it; every time it comes back, pump it.
  // `sid` names this continuation on both sides: every §5 local it excises (here and on
  // the answering side, which reads sid from the payload) is tagged with it, and released
  // when the drive settles — the owner heap stays flat across sequential sessions instead
  // of accumulating every session's excisions until disconnect.
  async function drive(peer: Peer, sid: string, res: PumpResult): Promise<unknown> {
    while (!res.done) {
      res = await settle(peer, await peer.request({ type: "resume", sid, ...meta }, ship(sid, res)));
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
    const flag = rec ? rec.flagOf(stack) : null;
    // twin calls' state changes ride the reply home (docs/migrate-arm.md "twins and
    // correctness"): the home tier applies them to the live instances before the
    // awaiting code resumes — read-your-writes without an extra crossing
    const twinDeltas: import("./types.mjs").TwinDelta[] = [];
    const sink = twins ? { twinDelta: (d: import("./types.mjs").TwinDelta) => twinDeltas.push(d) } : undefined;
    const carry = (): { twinDeltas?: import("./types.mjs").TwinDelta[] } => (twinDeltas.length ? { twinDeltas } : {});
    try {
      const res = await runPump(peer, stack, incoming, sink);
      if (res.done) return { obj: { type: "done", value: res.value, ...carry() } };
      return { obj: { type: "suspend", ...carry() }, bin: ship(sid, res) };
    } catch (e: any) {
      rec?.end(flag, "error");
      // error replies carry twin deltas too: mutations made before an uncaught throw
      // are real (plain JS keeps them) and the home instances must converge
      return { obj: { type: "error", message: String((e && e.message) || e), ...carry() } };
    }
  }

  const newSid = (): string => tier + "#" + nextSid++;   // starter-side unique; tiers differ, so two starters on one socket can't collide

  const host: Host = {
    pump,
    // Start entry(...args) on THIS tier and drive it to completion with the peer.
    run: async (peer, entry, args = [], opts = {}) => {
      const sid = newSid();
      const stack = initialStack(entry, args);
      const id = rec?.spawn(entry, opts.trace);
      if (id) rec!.stamp(stack, id);
      try { return await drive(peer, sid, await runPump(peer, stack)); }
      finally { finish(peer, sid); }
    },
    // Ask the PEER to start entry(...args) over there; service any bounces back here. The
    // trace decision is made HERE at spawn; no stack exists yet, so the flag rides the
    // start payload for exactly this one message — handleStart stamps it into the root
    // frame it builds, and it is stack-carried thereafter.
    call: async (peer, entry, args = [], opts = {}) => {
      const sid = newSid();
      const id = rec?.spawn(entry, opts.trace);
      try { return await drive(peer, sid, await settle(peer, await peer.request({ type: "start", entry, sid, ...(id ? { __trace: id } : {}), ...meta }, encodeArgs(args)))); }
      finally { finish(peer, sid); }
    },
    // The FETCH arm: the stack stays HERE for the whole run; a park at a foreign resource
    // sends only (name, args) and resumes with the value. Errors re-enter through the
    // pump's service() path, so the compiled code's own try/catch/finally see them. The
    // frame never serializes — compiled class methods (whose arg 0 is a live instance,
    // often a reactive proxy) run on this path, mutating the real object in place.
    // A request whose ARGS can't serialize (FormData, a progress callback in the config)
    // is intrinsically local: it executes here through opts.exec — the runtime mirror of
    // the axios adapter's pinned() test, with serializability itself as the signal.
    // opts.migrate flips a park to the MIGRATE arm (docs/migrate-arm.md): ship the whole
    // continuation to the resource's tier, run the chain there, come home by the stop rule.
    // (No trace recording yet: the recorder prices shipped stacks; fetch-hop records land
    // with the §6 decide-loop integration.)
    runLocal: async (peer, entry, args = [], opts = {}) => {
      // map/exec receive the PARKED TOP FRAME too: with nested machines (a store method
      // calling service methods), the instance that owns a park is that frame's args[0],
      // not the run's own arg 0 — interceptor chains and pinned fallbacks must follow it.
      const { exec: overrideExec, pins, map, migrate } = opts as { exec?: (req: ResourceRequest, frame?: Frame) => unknown; pins?: (req: ResourceRequest) => boolean; map?: (req: ResourceRequest, frame?: Frame) => ResourceRequest; migrate?: (req: ResourceRequest, site: { fn: string; pc: number; entry?: string }) => boolean };
      const baseExec = execOn(peer);
      const localExec: Exec = overrideExec ? (r) => overrideExec(r, stack[stack.length - 1]) : baseExec;
      const sid = newSid();
      let stack = initialStack(entry, args);
      // trace the fetch arm too: every serviced park is a resource touch at its (fn, pc)
      // site — the records a PROFILING run turns into the method-boundary migrate profile
      // (trace.mts methodMigrate). Head-sampled like everything else; zero cost untraced.
      const tid = rec?.spawn(entry, (opts as { trace?: boolean }).trace);
      if (tid) rec!.stamp(stack, tid, entry);   // entry conditions the method-boundary trajectory stats
      const flag = rec ? rec.flagOf(stack) : null;
      let request: PumpRequest | null = null;
      let carry: { value: unknown } | { error: unknown } | null = null;
      // §5 mini-heap for the MIGRATE arm: excised locals park here while the stack is away
      // and resolve back by identity when it returns. Scoped to this run — nothing leaks.
      let heapTier: { id: string; heapPut(v: unknown): string; heapGet(hid: string): unknown } | null = null;
      for (;;) {
        const c = carry; carry = null;
        // one-shot exec: the first service() call consumes the fetched result (or throws
        // the fetch error INTO the machine); anything else this tier owns runs normally.
        // The recorder wraps it so every serviced touch lands at its park site.
        const onceBase: Exec = (r) => { if (c) return "error" in c ? (() => { throw c.error; })() : c.value; return localExec(r); };
        const s = stack;
        const onceExec: Exec = !rec ? onceBase : async (r) => { const v = await onceBase(r); rec.res(s, r, v); return v; };
        const res = await pump(stack, ownsHere, onceExec, request);
        if (res.done) { rec?.end(flag, "done"); return res.value; }
        request = res.request;
        // a HOME park (§5 stop rule) is not a resource: the stack can only continue
        // where the handle lives, so it takes the resume path below unconditionally
        const parked = request.op === "home" ? null : request;
        // pinned = the family's declared semantics (opts.pins) OR args closing over
        // tier-owned values — executes here on the ORIGINAL request (the local exec is
        // the app's own instance; it applies its own request-time config exactly once)
        const localFallback = async (): Promise<void> => {
          try { carry = { value: await localExec(parked!) }; } catch (e) { carry = { error: e }; }
        };
        if (parked && ((pins && pins(parked)) || ownsValues(parked.args))) { await localFallback(); continue; }
        // opts.map prepares the CROSSING form — request-time config the compiled path
        // bypassed (interceptor chains, baseURL); null = the chain can't run here, pin
        const req = !parked ? request : map ? map(parked, stack[stack.length - 1]) : parked;
        if (!req) { await localFallback(); continue; }
        // THE MIGRATE ARM (docs/migrate-arm.md): ship the whole continuation to the
        // resource's tier instead of fetching the value back. Tier-owned locals excise
        // into the run's mini-heap and cross as handles; the peer pumps the chain with
        // its own exec and returns done, or the stack itself — parked home by the stop
        // rule (op:"home", value already in the frame) or at a resource only this tier
        // can serve. Errors the compiled code catches unwind over there; only uncaught
        // ones surface here, exactly as they would have escaped the local pump.
        const top = stack[stack.length - 1];
        if (!parked || (migrate && migrate(parked, { fn: top.fn, pc: top.pc, entry }))) {
          if (!heapTier) { const objs = new Map<string, unknown>(); let n = 0; heapTier = { id: tier, heapPut: (v) => { const k = "l" + n++; objs.set(k, v); return k; }, heapGet: (hid) => objs.get(hid) }; }
          const enc = (): Uint8Array => encodeWireBinary(stack, req, { tier: heapTier!, excise: ownedUnit });
          const reply = await peer.request({ type: "resume", sid, ...meta }, rec ? rec.ship(stack, req, enc, "migrate") : enc());
          // twin write-back (docs/migrate-arm.md "twins and correctness"): apply the
          // fields the session twins mutated to OUR live instances BEFORE the awaiting
          // code resumes — it reads its writes exactly as if the method ran at home.
          // Applied on ERROR replies too: mutations made before an uncaught throw are
          // real, exactly as they would be had the method run here.
          for (const d of (reply.obj.twinDeltas as import("./types.mjs").TwinDelta[] | undefined) ?? []) {
            if (d.owner !== tier) continue;
            const live = heapTier.heapGet(d.id);
            if (live && typeof live === "object") Object.assign(live, d.fields);
          }
          if (reply.obj.type === "error") throw new Error(reply.obj.message);
          if (reply.obj.type === "done") return reply.obj.value;
          const back = decodeWireBinary(reply.bin!, { tier: heapTier });
          stack = back.stack as Frame[];
          request = back.request as PumpRequest | null;   // op:"home" -> pump steps on from ret; a browser-owned resource -> pump services it here
          continue;
        }
        try { carry = { value: await execOver(peer, req as ResourceRequest, meta) }; } catch (e) { carry = { error: e }; }
      }
    },
    // The answering half, exposed as plain handlers so a dispatcher can route by meta.
    // A missing payload sid (an older peer) falls back to the connection-lifetime scope "".
    handleStart: (payload, bin, peer) => {
      const stack = initialStack(payload.entry, decodeArgs(bin!));
      if (rec && typeof payload.__trace === "string") rec.stamp(stack, payload.__trace);
      return step(peer, (payload && payload.sid) || "", stack, null);
    },
    handleResume: (payload, bin, peer) => { const { stack, request } = decodeWireBinary(bin!); return step(peer, (payload && payload.sid) || "", stack as Frame[], request as ResourceRequest | null); },
    // Serve a BURST of fetched resources in one crossing (the browser's microtask
    // batcher, docs/migrate-arm.md "burst coalescing"): bin is a vector of the same
    // per-exec payloads, results return per-element — value or shaped error — so each
    // caller's catch sees exactly what its own single exec would have produced.
    handleExecBatch: async (payload, bin) => {
      const items = decodeArgs(bin!) as [string, unknown[]][];
      const results = await Promise.all(items.map(async ([name, rargs]) => {
        try {
          return { ok: true, value: await exec({ op: "resource", tier: payload.tier || tier, name, args: rargs }) };
        } catch (e: any) {
          const r = e?.response;
          return { ok: false, message: String((e && e.message) || e),
            ...(r ? { response: { status: r.status, statusText: r.statusText ?? "", headers: r.headers ?? {}, data: r.data } } : {}) };
        }
      }));
      return { obj: { type: "done", value: results } };
    },
    // Serve one fetched resource for a peer's runLocal: no stack arrives and none returns.
    // An HTTP-semantics failure keeps its response (status, headers, body) — app code
    // reads error.response.data for its own error handling, on either tier.
    handleExec: async (payload, bin) => {
      try {
        const [name, rargs] = decodeArgs(bin!) as [string, unknown[]];
        const value = await exec({ op: "resource", tier: payload.tier || tier, name, args: rargs });
        return { obj: { type: "done", value } };
      } catch (e: any) {
        const r = e?.response;
        return { obj: { type: "error", message: String((e && e.message) || e),
          ...(r ? { response: { status: r.status, statusText: r.statusText ?? "", headers: r.headers ?? {}, data: r.data } } : {}) } };
      }
    },
    // Convenience: answer starts/resumes on a peer when this host is the only one on it —
    // and serve this connection's §5 heap so the other tier can fetch its handles back.
    answer(peer) {
      peer.on("start", (p, bin) => host.handleStart(p, bin, peer));
      peer.on("resume", (p, bin) => host.handleResume(p, bin, peer));
      peer.on("exec", (p, bin) => host.handleExec(p, bin));
      peer.on("execBatch", (p, bin) => host.handleExecBatch(p, bin));
      if (coherence) coherence.serve(peer);
      return host;
    },
  };
  return host;
}

// ONE fetched crossing on a peer, as a first-class op: send (name, args), return the
// value or throw the SHAPED error (error.response/isAxiosError intact — app code reads
// them either way). This is exactly the exchange runLocal's fetch arm performs at a
// park; exposed so an I/O-bottom adapter can cross the session without a machine.
export async function execOver(peer: Peer, req: ResourceRequest, meta: Record<string, unknown> = {}): Promise<unknown> {
  const { obj } = await peer.request({ type: "exec", tier: req.tier, ...meta }, encodeArgs([req.name, req.args]));
  if (obj.type === "error") {
    const err = new Error(obj.message) as Error & { response?: unknown; isAxiosError?: boolean; code?: string };
    if (obj.response) {                                      // HTTP-semantics failure: app code reads error.response.data
      err.response = obj.response; err.isAxiosError = true;
      err.code = (obj.response as { status: number }).status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST";
    }
    throw err;
  }
  return obj.value;
}

// Route peer messages to one of several hosts by a payload field (default "module") —
// used when several compiled modules share one socket (the Vite integration): each
// mix-module's host stamps its id into `meta`, and the other side dispatches on it.
export function answerWith(peer: Peer, hostFor: (id: string) => Host | Promise<Host>, field: string = "module"): void {
  const pick = async (payload: any): Promise<Host> => hostFor((payload && payload[field]) || "");
  peer.on("start", async (p, bin) => (await pick(p)).handleStart(p, bin, peer));   // thread the peer so a §5 deref can fetch back over it
  peer.on("resume", async (p, bin) => (await pick(p)).handleResume(p, bin, peer));
  peer.on("exec", async (p, bin) => (await pick(p)).handleExec(p, bin));
  peer.on("execBatch", async (p, bin) => (await pick(p)).handleExecBatch(p, bin));
}

// Burst coalescing at the exec boundary: reactive apps fire CONCURRENT resource touches
// (N components mount, each runLocal parks at its own http.* in the same tick) — the
// fetch arm sends N ws frames where one would do. This wrapper holds exec requests for
// one timer turn (setTimeout 0 — a microtask flush fires before sibling pumps reach
// their parks; the ~1 ms window is noise against a 20 ms RTT) and merges same-(tier,
// module) requests into one execBatch. Per-element results unwrap to exactly the reply
// shape a single exec would have produced, so runLocal is untouched. Safe by
// construction: only requests that were ALREADY in flight together merge — ordering
// between concurrent execs was never defined. A lone request passes through unchanged.
export function batchExec(peer: Peer): Peer {
  type Waiter = { bin: Uint8Array; res: (r: { obj: any; bin: Uint8Array | null }) => void; rej: (e: unknown) => void };
  const queues = new Map<string, { payload: any; waiters: Waiter[] }>();
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    const batches = [...queues.values()];
    queues.clear();
    for (const b of batches) {
      if (b.waiters.length === 1) { const w = b.waiters[0]; peer.request(b.payload, w.bin).then(w.res, w.rej); continue; }
      // decode the queued frames back to (name, args) pairs and re-encode as ONE vector:
      // the batch shares one interned string table (urls, header names) — smaller than
      // the sum of the frames it replaces. (Uint8Array is not a codec leaf, so the bins
      // themselves can't nest.)
      peer.request({ ...b.payload, type: "execBatch" }, encodeArgs(b.waiters.map((w) => decodeArgs(w.bin))))
        .then(({ obj }) => b.waiters.forEach((w, i) => {
          const r = (obj.value as ({ ok: true; value: unknown } | { ok: false; message: string; response?: unknown })[] | undefined)?.[i];
          if (!r) w.res({ obj: { type: "error", message: obj.message || "tierless: execBatch reply missing element " + i }, bin: null });
          else if (r.ok) w.res({ obj: { type: "done", value: r.value }, bin: null });
          else w.res({ obj: { type: "error", message: r.message, ...(r.response ? { response: r.response } : {}) }, bin: null });
        }), (e) => b.waiters.forEach((w) => w.rej(e)));
    }
  };
  return {
    request(payload: any, bin?: Uint8Array) {
      if (!payload || payload.type !== "exec" || !bin) return peer.request(payload, bin);
      return new Promise((res, rej) => {
        const key = JSON.stringify([payload.tier, payload.module ?? null]);
        let q = queues.get(key);
        if (!q) queues.set(key, (q = { payload, waiters: [] }));
        q.waiters.push({ bin, res, rej });
        if (!scheduled) { scheduled = true; setTimeout(flush, 0); }
      });
    },
    on: (type, handler) => peer.on(type, handler),
    close: () => peer.close(),
  };
}
