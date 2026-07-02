// stackmix/browser — the browser host: one socket, answer migrations, call actions.
import type { Bundle, Exec } from "./index.js";

export interface Connection {
  ready: Promise<void>;
  register(module: string, bundle: Bundle): unknown;
  /** Start entry(...args) on the SERVER; bounces back here are serviced by `exec`. */
  call(entry: string, args?: unknown[], module?: string): Promise<unknown>;
  close(): void;
}

export function connect(opts?: {
  url?: string;
  /** Services browser-pinned resources (dom.commit in the full-tierless mode, ui.* if pinned). */
  exec?: Exec;
  bundle?: Bundle;
  tier?: string;
}): Connection;

/** Page-level configuration for the shared lazy connection the compiled "use mix"
 *  modules use. Call before the first action fires. */
export function configureStackmix(opts: { url?: string; exec?: Exec }): void;

/** What compiled mix modules call: one bound async wrapper per PROGRAM, all sharing
 *  one lazy page connection. */
export function bindActions(bundle: Bundle, opts?: { module?: string }):
  Record<string, (...args: unknown[]) => Promise<unknown>>;
