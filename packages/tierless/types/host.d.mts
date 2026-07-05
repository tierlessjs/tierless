import { type RecorderOpts, type Recorder } from "./trace.mjs";
import type { Bundle, Exec, Peer, Host } from "./types.mjs";
export type { Bundle, Frame, MachineResult, ResourceRequest, Exec, Peer, Host } from "./types.mjs";
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
export declare function makeHost({ bundle, tier, exec, owns, meta, trace }: MakeHostOpts): Host;
export declare function answerWith(peer: Peer, hostFor: (id: string) => Host | Promise<Host>, field?: string): void;
