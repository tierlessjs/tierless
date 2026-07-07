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
import { makeRecorder } from "./trace.mjs";
import { DEREF_TIER, usesHeap } from "./coherence.mjs";
const isRecorder = (t) => typeof t.ship === "function";
// OWNERSHIP scan — the generic half of request pinning (a resource family adds its
// declared pins via opts.pins, e.g. axios's responseType:"blob"). A request is pinned
// when its args close over values whose identity or effects belong to THIS tier:
// functions (their effect lives in this heap), host objects (FormData/Blob wrap this
// tier's memory). Plain data — INCLUDING prototyped model instances, which axios itself
// would JSON-serialize — crosses structurally, exactly as it would have gone on the
// wire anyway. NOT a serializability test: that is a codec capability, changes with the
// codec, and can't see semantic pins at all. Depth-limited: pathological values pin
// (fail closed), never hang.
function ownsValues(v, depth = 0) {
    if (depth > 6)
        return true;
    if (v === null || v === undefined)
        return false;
    const t = typeof v;
    if (t === "function" || t === "symbol")
        return true;
    if (t !== "object")
        return false;
    if (typeof FormData !== "undefined" && v instanceof FormData)
        return true;
    if (typeof Blob !== "undefined" && v instanceof Blob)
        return true;
    if (v instanceof Date || v instanceof Uint8Array)
        return false;
    if (Array.isArray(v))
        return v.some((x) => ownsValues(x, depth + 1));
    return Object.values(v).some((x) => ownsValues(x, depth + 1)); // own enumerable props — what crosses; prototypes stay home like axios's JSON pass
}
// The migrate arm's §5 excision predicate (docs/migrate-arm.md): consulted per VALUE while
// the codec walks a shipping stack. Containers return false — the walk descends and each
// element decides for itself — so one owned element doesn't park a whole args array.
// Prototyped instances excise as units even when their data would serialize: crossing
// structurally would hand back a prototype-stripped copy, and a later segment that touches
// the slot must see the SAME object (the stop rule guarantees that touch happens at home).
function ownedUnit(v) {
    if (typeof v === "function")
        return true;
    if (v === null || typeof v !== "object")
        return false;
    if (Array.isArray(v) || v instanceof Map || v instanceof Set)
        return false;
    if (v instanceof Date || v instanceof Uint8Array)
        return false;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null)
        return true;
    return ownsValues(v);
}
let nextSid = 1;
export function makeHost({ bundle, tier, exec, owns, meta = {}, trace, coherence: coherenceIn, twins }) {
    const pump = makePump(bundle, { twins });
    const coherence = coherenceIn && usesHeap(bundle) ? coherenceIn : undefined; // per-bundle gate (see MakeHostOpts.coherence)
    const ownsBase = owns || ((t) => t === tier);
    // The host also owns the heap pseudo-tiers ("@deref"/"@writeback"): a handle read or a
    // mutation's propagation is serviced HERE (this tier), never migrated.
    const ownsHere = coherence ? ((t) => ownsBase(t) || coherence.owns(t)) : ownsBase;
    const encOpts = (sid) => (coherence ? coherence.encodeOpts(sid) : {});
    const rec = trace ? (isRecorder(trace) ? trace : makeRecorder(trace)) : null;
    // The exec the pump runs, bound to the peer the current message rides: an "@deref" is a
    // coherent fetch back over `peer` on a cache miss; an "@writeback" proposes the mutated
    // snapshot to its owner over `peer` under an optimistic CAS. Every other owned resource
    // goes to the app exec. With no coherence this is just the app exec.
    const execOn = coherence
        ? (peer) => (req) => (coherence.owns(req.tier)
            ? (req.tier === DEREF_TIER ? coherence.deref(peer, req.args[0]) : coherence.writeBack(peer, req.args[0]))
            : exec(req))
        : () => exec;
    // A traced run measures every resource touch (site + argument features + result size —
    // the ordered sequence the trajectory profile is built from). Only when a recorder is
    // configured does the exec get wrapped; the wrapper itself no-ops on untraced stacks.
    const execFor = (peer, stack) => {
        const base = execOn(peer);
        return !rec ? base : async (req) => { const v = await base(req); rec.res(stack, req, v); return v; };
    };
    // A traced stack's flag is captured BEFORE pumping: a finished pump has popped every
    // frame, so the end marker needs the flag held aside. Untraced stacks pump exactly as before.
    const runPump = async (peer, stack, incoming = null) => {
        const flag = rec ? rec.flagOf(stack) : null;
        const res = await pump(stack, ownsHere, execFor(peer, stack), incoming);
        if (res.done)
            rec?.end(flag, "done");
        return res;
    };
    // The continuation is about to cross: the recorder bumps the stack-carried counters,
    // encodes, and records the site with the REAL shipped bytes. The shipped host always
    // migrates today; a §6 driver records its actual choice itself.
    const ship = (sid, res) => rec ? rec.ship(res.stack, res.request, () => encodeWireBinary(res.stack, res.request, encOpts(sid)), "migrate")
        : encodeWireBinary(res.stack, res.request, encOpts(sid));
    // Interpret a peer reply: done -> final value; suspend -> pump the migrated stack here
    // (which may end done, or park at another foreign resource for the caller to bounce).
    async function settle(peer, { obj: reply, bin }) {
        if (reply.type === "error")
            throw new Error(reply.message);
        if (reply.type === "done")
            return { done: true, value: reply.value };
        const { stack, request } = decodeWireBinary(bin);
        return runPump(peer, stack, request); // a "suspend" reply's bin always decodes to what the sender's PumpResult shipped — a real continuation stack + ResourceRequest
    }
    // Bounce a local result with the peer until the session completes: every time the
    // continuation parks at a foreign resource, ship it; every time it comes back, pump it.
    // `sid` names this continuation on both sides: every §5 local it excises (here and on
    // the answering side, which reads sid from the payload) is tagged with it, and released
    // when the drive settles — the owner heap stays flat across sequential sessions instead
    // of accumulating every session's excisions until disconnect.
    async function drive(peer, sid, res) {
        while (!res.done) {
            res = await settle(peer, await peer.request({ type: "resume", sid, ...meta }, ship(sid, res)));
        }
        return res.value;
    }
    // A continuation settled (value or error): free the §5 masters it excised, on both sides.
    const finish = (peer, sid) => {
        if (coherence) {
            coherence.release(sid);
            coherence.releaseRemote(peer, sid);
        }
    };
    // Serve one migrated-in step: pump from where the peer left off, reply done/suspend.
    // `peer` is the socket the step arrived on — §5 derefs/write-backs go back over it; the
    // payload's sid tags any locals this step excises, released by the starter's completion.
    async function step(peer, sid, stack, incoming) {
        const flag = rec ? rec.flagOf(stack) : null;
        try {
            const res = await runPump(peer, stack, incoming);
            if (res.done)
                return { obj: { type: "done", value: res.value } };
            return { obj: { type: "suspend" }, bin: ship(sid, res) };
        }
        catch (e) {
            rec?.end(flag, "error");
            return { obj: { type: "error", message: String((e && e.message) || e) } };
        }
    }
    const newSid = () => tier + "#" + nextSid++; // starter-side unique; tiers differ, so two starters on one socket can't collide
    const host = {
        pump,
        // Start entry(...args) on THIS tier and drive it to completion with the peer.
        run: async (peer, entry, args = [], opts = {}) => {
            const sid = newSid();
            const stack = initialStack(entry, args);
            const id = rec?.spawn(entry, opts.trace);
            if (id)
                rec.stamp(stack, id);
            try {
                return await drive(peer, sid, await runPump(peer, stack));
            }
            finally {
                finish(peer, sid);
            }
        },
        // Ask the PEER to start entry(...args) over there; service any bounces back here. The
        // trace decision is made HERE at spawn; no stack exists yet, so the flag rides the
        // start payload for exactly this one message — handleStart stamps it into the root
        // frame it builds, and it is stack-carried thereafter.
        call: async (peer, entry, args = [], opts = {}) => {
            const sid = newSid();
            const id = rec?.spawn(entry, opts.trace);
            try {
                return await drive(peer, sid, await settle(peer, await peer.request({ type: "start", entry, sid, ...(id ? { __trace: id } : {}), ...meta }, encodeArgs(args))));
            }
            finally {
                finish(peer, sid);
            }
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
            const { exec: overrideExec, pins, map, migrate } = opts;
            const localExec = overrideExec || execOn(peer);
            const sid = newSid();
            let stack = initialStack(entry, args);
            // trace the fetch arm too: every serviced park is a resource touch at its (fn, pc)
            // site — the records a PROFILING run turns into the method-boundary migrate profile
            // (trace.mts methodMigrate). Head-sampled like everything else; zero cost untraced.
            const tid = rec?.spawn(entry, opts.trace);
            if (tid)
                rec.stamp(stack, tid);
            const flag = rec ? rec.flagOf(stack) : null;
            let request = null;
            let carry = null;
            // §5 mini-heap for the MIGRATE arm: excised locals park here while the stack is away
            // and resolve back by identity when it returns. Scoped to this run — nothing leaks.
            let heapTier = null;
            for (;;) {
                const c = carry;
                carry = null;
                // one-shot exec: the first service() call consumes the fetched result (or throws
                // the fetch error INTO the machine); anything else this tier owns runs normally.
                // The recorder wraps it so every serviced touch lands at its park site.
                const onceBase = (r) => { if (c)
                    return "error" in c ? (() => { throw c.error; })() : c.value; return localExec(r); };
                const s = stack;
                const onceExec = !rec ? onceBase : async (r) => { const v = await onceBase(r); rec.res(s, r, v); return v; };
                const res = await pump(stack, ownsHere, onceExec, request);
                if (res.done) {
                    rec?.end(flag, "done");
                    return res.value;
                }
                request = res.request;
                // pinned = the family's declared semantics (opts.pins) OR args closing over
                // tier-owned values — executes here on the ORIGINAL request (the local exec is
                // the app's own instance; it applies its own request-time config exactly once)
                const localFallback = async () => {
                    try {
                        carry = { value: await localExec(request) };
                    }
                    catch (e) {
                        carry = { error: e };
                    }
                };
                if ((pins && pins(request)) || ownsValues(request.args)) {
                    await localFallback();
                    continue;
                }
                // opts.map prepares the CROSSING form — request-time config the compiled path
                // bypassed (interceptor chains, baseURL); null = the chain can't run here, pin
                const req = map ? map(request) : request;
                if (!req) {
                    await localFallback();
                    continue;
                }
                // THE MIGRATE ARM (docs/migrate-arm.md): ship the whole continuation to the
                // resource's tier instead of fetching the value back. Tier-owned locals excise
                // into the run's mini-heap and cross as handles; the peer pumps the chain with
                // its own exec and returns done, or the stack itself — parked home by the stop
                // rule (op:"home", value already in the frame) or at a resource only this tier
                // can serve. Errors the compiled code catches unwind over there; only uncaught
                // ones surface here, exactly as they would have escaped the local pump.
                const top = stack[stack.length - 1];
                if (migrate && migrate(request, { fn: top.fn, pc: top.pc })) {
                    if (!heapTier) {
                        const objs = new Map();
                        let n = 0;
                        heapTier = { id: tier, heapPut: (v) => { const k = "l" + n++; objs.set(k, v); return k; }, heapGet: (hid) => objs.get(hid) };
                    }
                    const enc = () => encodeWireBinary(stack, req, { tier: heapTier, excise: ownedUnit });
                    const reply = await peer.request({ type: "resume", sid, ...meta }, rec ? rec.ship(stack, req, enc, "migrate") : enc());
                    if (reply.obj.type === "error")
                        throw new Error(reply.obj.message);
                    if (reply.obj.type === "done")
                        return reply.obj.value;
                    const back = decodeWireBinary(reply.bin, { tier: heapTier });
                    stack = back.stack;
                    request = back.request; // op:"home" -> pump steps on from ret; a browser-owned resource -> pump services it here
                    continue;
                }
                const { obj } = await peer.request({ type: "exec", tier: req.tier, ...meta }, encodeArgs([req.name, req.args]));
                if (obj.type === "error") {
                    const err = new Error(obj.message);
                    if (obj.response) { // HTTP-semantics failure: app code reads error.response.data
                        err.response = obj.response;
                        err.isAxiosError = true;
                        err.code = obj.response.status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST";
                    }
                    carry = { error: err };
                }
                else
                    carry = { value: obj.value };
            }
        },
        // The answering half, exposed as plain handlers so a dispatcher can route by meta.
        // A missing payload sid (an older peer) falls back to the connection-lifetime scope "".
        handleStart: (payload, bin, peer) => {
            const stack = initialStack(payload.entry, decodeArgs(bin));
            if (rec && typeof payload.__trace === "string")
                rec.stamp(stack, payload.__trace);
            return step(peer, (payload && payload.sid) || "", stack, null);
        },
        handleResume: (payload, bin, peer) => { const { stack, request } = decodeWireBinary(bin); return step(peer, (payload && payload.sid) || "", stack, request); },
        // Serve one fetched resource for a peer's runLocal: no stack arrives and none returns.
        // An HTTP-semantics failure keeps its response (status, headers, body) — app code
        // reads error.response.data for its own error handling, on either tier.
        handleExec: async (payload, bin) => {
            try {
                const [name, rargs] = decodeArgs(bin);
                const value = await exec({ op: "resource", tier: payload.tier || tier, name, args: rargs });
                return { obj: { type: "done", value } };
            }
            catch (e) {
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
            if (coherence)
                coherence.serve(peer);
            return host;
        },
    };
    return host;
}
// Route peer messages to one of several hosts by a payload field (default "module") —
// used when several compiled modules share one socket (the Vite integration): each
// mix-module's host stamps its id into `meta`, and the other side dispatches on it.
export function answerWith(peer, hostFor, field = "module") {
    const pick = async (payload) => hostFor((payload && payload[field]) || "");
    peer.on("start", async (p, bin) => (await pick(p)).handleStart(p, bin, peer)); // thread the peer so a §5 deref can fetch back over it
    peer.on("resume", async (p, bin) => (await pick(p)).handleResume(p, bin, peer));
    peer.on("exec", async (p, bin) => (await pick(p)).handleExec(p, bin));
}
