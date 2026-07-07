import { type RecorderOpts, type Recorder } from "./trace.mjs";
import { type Coherence } from "./coherence.mjs";
import type { Bundle, Exec, Peer, Host } from "./types.mjs";
export type { Bundle, Frame, MachineResult, ResourceRequest, Exec, Peer, Host } from "./types.mjs";
export type { Coherence } from "./coherence.mjs";
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
}
export declare function makeHost({ bundle, tier, exec, owns, meta, trace, coherence: coherenceIn }: MakeHostOpts): Host;
export declare function answerWith(peer: Peer, hostFor: (id: string) => Host | Promise<Host>, field?: string): void;
