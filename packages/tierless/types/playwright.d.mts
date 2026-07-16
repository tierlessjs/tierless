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
export declare function globToRegexPattern(glob: string): string;
/** Patch `waitForResponse`/`waitForRequest` on a Page — or on a BrowserContext and every
 *  page it ever creates (popups included) — to also accept tierless session crossings.
 *  Idempotent. Call it once from the suite's fixture/setup; upstream spec files need no
 *  edits. `warn` (default console.warn) receives the once-per-cause notes when a
 *  caller's predicate reads something a crossing can't carry. */
export declare function installTransportWaits(target: PageLike | ContextLike, { warn }?: {
    warn?: (msg: string) => void;
}): Promise<void>;
export {};
