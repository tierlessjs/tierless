import type { Bundle, Exec, Host } from "./types.mjs";
export interface ConnectOpts {
    url?: string | (() => string);
    /** Services browser-pinned resources (dom.commit in the full-tierless mode, ui.* if pinned). */
    exec?: Exec;
    bundle?: Bundle;
    tier?: string;
    /** §5 heap coherence (deref a server-owned handle over the socket, write a mutation back
     *  under CAS, serve browser-owned handles). On by default; it takes effect per module —
     *  only --auto-deref/--auto-writeback bundles excise and service §5 ops, so ordinary
     *  bundles are unaffected. false disables it entirely. */
    heap?: boolean;
    /** Trace recording for PROFILING runs (run protocol, docs/corpus.md): every method
     *  run records its resource touches; records post to this URL as JSONL batches. */
    traceUrl?: string;
    /** Profile for COMPARISON runs: fetched from this URL at connect; when it loads (and
     *  its bundle hash matches the merged app world), bindMethods stubs consult the
     *  method-boundary §6 rule — chains migrate, everything else keeps the fetch arm. */
    profileUrl?: string;
}
export interface Connection {
    ready: Promise<void>;
    register(module: string, bundle: Bundle): Host;
    /** Start entry(...args) on the SERVER; bounces back here are serviced by `exec`. */
    call(entry: string, args?: unknown[], module?: string): Promise<unknown>;
    /** Run entry(...args) HERE; foreign resources are fetched over the session (the frame
     *  never ships — the compiled-class-method path, see bindMethods). opts.exec serves
     *  pinned requests on this tier; opts.pins adds the resource family's declared pins. */
    runLocal(entry: string, args?: unknown[], module?: string, opts?: {
        exec?: (req: import("./types.mjs").ResourceRequest, frame?: import("./types.mjs").Frame) => unknown | Promise<unknown>;
        pins?: (req: import("./types.mjs").ResourceRequest) => boolean;
        map?: (req: import("./types.mjs").ResourceRequest, frame?: import("./types.mjs").Frame) => import("./types.mjs").ResourceRequest | null;
        migrate?: (req: import("./types.mjs").ResourceRequest, site: {
            fn: string;
            pc: number;
            entry?: string;
        }) => boolean;
    }): Promise<unknown>;
    /** ONE resource request executed on the SERVER over this session — no machine, no
     *  frame: the fetch-arm crossing as a first-class op (host.mts execOver). The
     *  I/O-bottom adapter path: an app's axios adapter crosses here per request. */
    exec(req: import("./types.mjs").ResourceRequest): Promise<unknown>;
    close(): void;
}
export declare const mergedAppHash: () => string;
export declare function connect({ url, exec, bundle, tier, heap, traceUrl, profileUrl, }?: ConnectOpts): Connection;
/** The shared connection's exec crossing as a tierless Exec — what an I/O-bottom
 *  adapter plugs in to route the app's requests over the session socket:
 *  `axiosAdapter({ exec: sessionExec(), ... })`. Lazy: the socket opens on first use
 *  (or at configureTierless({ preconnect }) time), each call awaits readiness. */
export declare function sessionExec(): Exec;
export declare function configureTierless(opts: ConnectOpts & {
    preconnect?: boolean;
}): void;
export declare function bindActions(bundle: Bundle, { module }?: {
    module?: string;
}): Record<string, (...args: unknown[]) => Promise<unknown>>;
/** Route a compiled module's class-method stubs (real app code — service layers) through
 *  the shared connection. Methods run on the FETCH path: the frame — whose arg 0 is the
 *  live instance, often a framework proxy — stays in the browser and mutates the real
 *  object; only resource requests and results cross. Call once per compiled module. */
export declare function bindMethods(bundle: Bundle & {
    __bindTierlessMethods?: (fn: (prog: string, self: unknown, args: unknown[]) => Promise<unknown>) => void;
}, { module, migrate }?: {
    module?: string;
    migrate?: (req: import("./types.mjs").ResourceRequest, site: {
        fn: string;
        pc: number;
        entry?: string;
    }) => boolean;
}): void;
