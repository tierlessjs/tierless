interface FrameLike {
    url(): string;
}
interface BindingSource {
    page?: object;
    frame?: FrameLike;
}
interface Bindable {
    exposeBinding(name: string, cb: (source: BindingSource, arg: string) => unknown): Promise<void>;
    addInitScript(script: string): Promise<void>;
}
export interface PageLike extends Bindable {
    evaluate(script: string): Promise<unknown>;
    waitForResponse(urlOrPredicate: unknown, options?: unknown): Promise<unknown>;
    waitForRequest(urlOrPredicate: unknown, options?: unknown): Promise<unknown>;
}
export interface ContextLike extends Bindable {
    pages(): PageLike[];
    on(event: "page", cb: (page: PageLike) => void): unknown;
}
export { globToRegexPattern } from "./url-glob.mjs";
/** Patch `waitForResponse`/`waitForRequest` on a Page — or on a BrowserContext and every
 *  page it ever creates (popups included) — to also accept tierless session crossings.
 *  Idempotent. Call it once from the suite's fixture/setup; upstream spec files need no
 *  edits. `warn` (default console.warn) receives the once-per-cause notes when a
 *  caller's predicate reads something a crossing can't carry. */
export declare function installTransportWaits(target: PageLike | ContextLike, { warn }?: {
    warn?: (msg: string) => void;
}): Promise<void>;
type RouteMatcher = string | RegExp | ((url: unknown) => boolean);
interface RoutablePage {
    route(url: RouteMatcher, handler: unknown, options?: unknown): Promise<void>;
    evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
    addInitScript(script: unknown, arg?: unknown): Promise<void>;
}
interface RoutableContext {
    route(url: RouteMatcher, handler: unknown, options?: unknown): Promise<void>;
    pages(): RoutablePage[];
    on(event: "page", cb: (page: RoutablePage) => void): unknown;
}
/** Wrap a BrowserContext's route() — and every page's, current and future — so each
 *  intercepted URL pattern registers as force-browser on the ported build's seam
 *  (`window.__tierlessForceBrowser`, read by adapt-auto). Mocked requests then stay on
 *  the browser's fetch where the intercept can fire. Idempotent per target. */
export declare function recordForceBrowserRoutes(context: RoutableContext): void;
export interface SuitePlaywright {
    Page: {
        prototype: Record<string, unknown>;
    };
    BrowserContext: {
        prototype: Record<string, unknown>;
    };
}
/** Dig the suite's own playwright-core client classes out of its dependency tree
 *  (absolute-path require — the internals aren't in the exports map). `fromDir` is the
 *  suite directory whose resolution should be used, so the patched Page class is the
 *  SAME class the suite's fixtures hand to tests. */
export declare function resolveSuitePlaywright(fromDir: string): SuitePlaywright;
/** Patch the suite's Page class so EVERY page's waits are transport-agnostic — the
 *  zero-touch form of installTransportWaits, applied from a generated config wrapper.
 *  `initScript` (optional) is added to every context before its first page — the
 *  harness's channel for page-visible run parameters (e.g. seeding the tierlessWsUrl
 *  localStorage override on shaped runs) without touching the app or the suite. */
export declare function patchPlaywrightPages({ Page, BrowserContext }: SuitePlaywright, { warn, initScript }?: {
    warn?: (msg: string) => void;
    initScript?: string;
}): void;
/** Re-anchor a config object's relative paths to the directory of the config file it
 *  came from — what a `--config` wrapper OUTSIDE the suite tree needs, since Playwright
 *  resolves these against the wrapper's own location. Projects are anchored too. */
export declare function anchorPlaywrightConfig<T extends Record<string, unknown>>(config: T, dir: string): T;
