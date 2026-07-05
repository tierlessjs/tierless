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
    close(): void;
}
export declare function connect({ url, exec, bundle, tier }?: ConnectOpts): Connection;
export declare function configureTierless(opts: ConnectOpts & {
    preconnect?: boolean;
}): void;
export declare function bindActions(bundle: Bundle, { module }?: {
    module?: string;
}): Record<string, (...args: unknown[]) => Promise<unknown>>;
