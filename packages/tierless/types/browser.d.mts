import type { Bundle, Exec, Host } from "./types.mjs";
export interface ConnectOpts {
    url?: string | (() => string);
    /** Services browser-pinned resources (dom.commit in the full-tierless mode, ui.* if pinned). */
    exec?: Exec;
    bundle?: Bundle;
    tier?: string;
}
export interface Connection {
    ready: Promise<void>;
    register(module: string, bundle: Bundle): Host;
    /** Start entry(...args) on the SERVER; bounces back here are serviced by `exec`. */
    call(entry: string, args?: unknown[], module?: string): Promise<unknown>;
    /** Run entry(...args) HERE; foreign resources are fetched over the session (the frame
     *  never ships — the compiled-class-method path, see bindMethods). localExec serves
     *  requests whose args can't cross (FormData, callbacks) on this tier. */
    runLocal(entry: string, args?: unknown[], module?: string, localExec?: Exec): Promise<unknown>;
    close(): void;
}
export declare function connect({ url, exec, bundle, tier }?: ConnectOpts): Connection;
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
}, { module }?: {
    module?: string;
}): void;
