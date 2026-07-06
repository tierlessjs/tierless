import type { Coherence } from "./coherence.mjs";
import type { Bundle, Exec, Peer, Host } from "./types.mjs";
export type { Bundle, Frame, MachineResult, ResourceRequest, Exec, Peer, Host } from "./types.mjs";
export type { Coherence } from "./coherence.mjs";
export interface MakeHostOpts {
    bundle: Bundle;
    tier: string;
    exec: Exec;
    owns?: (tier: string) => boolean;
    meta?: Record<string, unknown>;
    /** §5 heap coherence for this connection (excision + deref-over-socket, bounded cache).
     *  When set, the host owns the "@deref" pseudo-tier and excises big locals on the wire.
     *  Omit it and the host behaves exactly as before — no handles, no deref servicing. */
    coherence?: Coherence;
}
export declare function makeHost({ bundle, tier, exec, owns, meta, coherence }: MakeHostOpts): Host;
export declare function answerWith(peer: Peer, hostFor: (id: string) => Host | Promise<Host>, field?: string): void;
