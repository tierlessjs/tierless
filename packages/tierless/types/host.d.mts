import type { Bundle, Exec, Peer, Host } from "./types.mjs";
export type { Bundle, Frame, MachineResult, ResourceRequest, Exec, Peer, Host } from "./types.mjs";
export interface MakeHostOpts {
    bundle: Bundle;
    tier: string;
    exec: Exec;
    owns?: (tier: string) => boolean;
    meta?: Record<string, unknown>;
}
export declare function makeHost({ bundle, tier, exec, owns, meta }: MakeHostOpts): Host;
export declare function answerWith(peer: Peer, hostFor: (id: string) => Host | Promise<Host>, field?: string): void;
