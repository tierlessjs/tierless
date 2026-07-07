import type { Bundle, Frame, Pump } from "./types.mjs";
export type { Bundle, Frame, MachineResult, ResourceRequest, Exec, Peer, Host } from "./types.mjs";
export declare const initialStack: (fn: string, args?: unknown[]) => Frame[];
export interface PumpOpts {
    /** Session twin registry (docs/migrate-arm.md slice 3): resolves a class-stamped §5
     *  handle to a LOCAL instance of that class, so a dynamic call park runs the real
     *  method — its own interceptors, its own state — on this tier. Opt-in per class:
     *  return undefined and the park falls through to a machine push or a home park. */
    twins?: (cls: string) => object | undefined;
}
export declare function makePump(bundle: Bundle, { twins }?: PumpOpts): Pump;
