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
export function makeHost({ bundle, tier, exec, owns, meta = {}, coherence }) {
    const pump = makePump(bundle);
    const ownsBase = owns || ((t) => t === tier);
    // The host also owns "@deref": a handle read is serviced HERE (this tier), never migrated.
    const ownsHere = coherence ? ((t) => ownsBase(t) || coherence.ownsDeref(t)) : ownsBase;
    const encOpts = coherence ? coherence.encodeOpts : {};
    // The exec the pump runs, bound to the peer the current message rides: an "@deref" is
    // serviced by the coherence host (a fetch back over `peer` on a cache miss); every other
    // owned resource goes to the app exec. With no coherence this is just the app exec.
    const execOn = coherence
        ? (peer) => (req) => (coherence.ownsDeref(req.tier) ? coherence.deref(peer, req.args[0]) : exec(req))
        : () => exec;
    // Interpret a peer reply: done -> final value; suspend -> pump the migrated stack here
    // (which may end done, or park at another foreign resource for the caller to bounce).
    async function settle(peer, { obj: reply, bin }) {
        if (reply.type === "error")
            throw new Error(reply.message);
        if (reply.type === "done")
            return { done: true, value: reply.value };
        const { stack, request } = decodeWireBinary(bin);
        return pump(stack, ownsHere, execOn(peer), request); // a "suspend" reply's bin always decodes to what the sender's PumpResult shipped — a real continuation stack + ResourceRequest
    }
    // Bounce a local result with the peer until the session completes: every time the
    // continuation parks at a foreign resource, ship it; every time it comes back, pump it.
    async function drive(peer, res) {
        while (!res.done) {
            res = await settle(peer, await peer.request({ type: "resume", ...meta }, encodeWireBinary(res.stack, res.request, encOpts)));
        }
        return res.value;
    }
    // Serve one migrated-in step: pump from where the peer left off, reply done/suspend.
    // `peer` is the socket the step arrived on — used to fetch a §5 handle back if the
    // continuation derefs one here.
    async function step(peer, stack, incoming) {
        try {
            const res = await pump(stack, ownsHere, execOn(peer), incoming);
            if (res.done)
                return { obj: { type: "done", value: res.value } };
            return { obj: { type: "suspend" }, bin: encodeWireBinary(res.stack, res.request, encOpts) };
        }
        catch (e) {
            return { obj: { type: "error", message: String((e && e.message) || e) } };
        }
    }
    const host = {
        pump,
        // Start entry(...args) on THIS tier and drive it to completion with the peer.
        run: async (peer, entry, args = []) => drive(peer, await pump(initialStack(entry, args), ownsHere, execOn(peer))),
        // Ask the PEER to start entry(...args) over there; service any bounces back here.
        call: async (peer, entry, args = []) => drive(peer, await settle(peer, await peer.request({ type: "start", entry, ...meta }, encodeArgs(args)))),
        // The answering half, exposed as plain handlers so a dispatcher can route by meta.
        handleStart: (payload, bin, peer) => step(peer, initialStack(payload.entry, decodeArgs(bin)), null),
        handleResume: (payload, bin, peer) => { const { stack, request } = decodeWireBinary(bin); return step(peer, stack, request); },
        // Convenience: answer starts/resumes on a peer when this host is the only one on it —
        // and serve this connection's §5 heap so the other tier can fetch its handles back.
        answer(peer) {
            peer.on("start", (p, bin) => host.handleStart(p, bin, peer));
            peer.on("resume", (p, bin) => host.handleResume(p, bin, peer));
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
}
