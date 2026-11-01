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
/** A view this tier decoded, with its members as they arrived: what viewDelta diffs
 *  against when the run leaves. */
export interface TrackedView {
    view: object;
    h: Handle;
    pre: Record<string, unknown> | unknown[];
}
/** A view's writes since it arrived (docs/migrate-arm.md "writable views"): the members
 *  assigned or added, by identity — a view's containers are views of their own, with
 *  deltas of their own — the members deleted, and an array's new length. Rides the
 *  crossing's graph (wire-binary.mts) and lands on the live object at home (applyDeltas). */
export declare function viewDelta({ view, h, pre }: TrackedView): TwinDelta | null;
export declare function hydrateViews(stack: Frame[], twins: NonNullable<PumpOpts["twins"]>): {
    twins: Array<{
        twin: object;
        where: TwinWhere;
        pre: Record<string, string | undefined>;
    }>;
    views: TrackedView[];
};
import type { Handle } from "./graph.mjs";
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
export declare function makePump(bundle: Bundle, { twins }?: PumpOpts): Pump & {
    runSync: (fn: string, args: unknown[]) => unknown;
};
