import type { Bundle, Frame, Pump } from "./types.mjs";
export type { Bundle, Frame, MachineResult, ResourceRequest, Exec, Peer, Host } from "./types.mjs";
export declare const initialStack: (fn: string, args?: unknown[]) => Frame[];
export declare function makePump(bundle: Bundle): Pump;
