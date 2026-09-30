import type { Bundle, Frame, Pump, TwinDelta } from "./types.mjs";
type TwinWhere = {
    owner: string;
    id: string;
    path?: string[];
};
export declare function twinImage(twin: object): Record<string, string | undefined>;
export declare function twinDelta(pre: Record<string, string | undefined>, twin: object, where: TwinWhere): TwinDelta | null;
/** HYDRATE a migrated stack: every caps VIEW member that is a stamped member handle with
 *  a session twin here becomes the twin itself. Plain code the machine runs on this tier —
 *  an inline `async x => await client.find(x)` handed to Promise.all — then calls the
 *  twin natively, and the stop rule sees a live object, not a handle, so the run stays.
 *  Returns each twin with its snapshot: the caller diffs them once per crossing (no
 *  per-call hook exists for plain code). Going home, the encoder writes a hydrated twin
 *  back as its handle (graph.mts `hydrated`). */
export declare function hydrateViews(stack: Frame[], twins: NonNullable<PumpOpts["twins"]>): Array<{
    twin: object;
    where: TwinWhere;
    pre: Record<string, string | undefined>;
}>;
export type { Bundle, Frame, MachineResult, ResourceRequest, HomePark, PumpRequest, Exec, Peer, Host } from "./types.mjs";
export declare const initialStack: (fn: string, args?: unknown[]) => Frame[];
export interface PumpOpts {
    /** Session twin registry (docs/migrate-arm.md slice 3): resolves a class-stamped §5
     *  handle to a LOCAL instance of that class, so a dynamic call park runs the real
     *  method — its own interceptors, its own state — on this tier. Opt-in per class:
     *  return undefined and the park falls through to a machine push or a home park.
     *  `handle` carries the receiver's identity (owner tier + heap id): a registry serving
     *  stateful per-instance classes must key on it, or two distinct home instances would
     *  share one twin's state. Keying by class alone is right only for singletons. */
    twins?: (cls: string, handle?: {
        id: string;
        owner: string;
        path?: string[];
        state?: Record<string, unknown>;
    }) => object | undefined;
}
export declare function makePump(bundle: Bundle, { twins }?: PumpOpts): Pump;
