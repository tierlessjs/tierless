export interface TierlessPluginOptions {
    /** Path to the trusted service module (forked as a reference-monitor sidecar). */
    api?: string;
    /** Demo session: log in once per connection with these credentials, carry the token. */
    login?: {
        user: string;
        pass: string;
    } | null;
    /** Extra allow-list namespaces merged over the api/commit defaults. Note: the dev plugin's own
     *  server exec (`makeApiExec` over the sidecar) services `api.*` only — pinning another namespace
     *  here also needs a custom exec that can service it, or those calls throw at runtime. */
    resources?: Record<string, string>;
    /** Import specifier for the browser host in emitted modules (test override). */
    runtime?: string;
    /** Session endpoint path (defaults to WS_PATH). */
    path?: string;
    /** Passed through to the compiler (e.g. `trackWrites`). Note: the compiler's `sourceMap` emits a
     *  runtime frame→line table for `file:line` reporting (see source-maps.mts), not a debugger
     *  sourcemap Vite can chain — this transform returns no map (see below). */
    compilerOptions?: Record<string, unknown>;
    /** Where `vite build` writes the server bundles + manifest (see writeBundle). Relative to the
     *  Vite root; kept OUT of the client outDir so server code is never served. Default `dist-tierless`. */
    serverOutDir?: string;
    /** ROUTE WORKFLOWS — adapting an existing app (docs/corpus.md rung 3). Route pattern ->
     *  "use tierless" module path (root-relative). On SPA navigation to a matching route the
     *  injected shim runs the workflow over the session socket and answers the app's own
     *  matching GET requests from the result — the app's components run untouched. */
    workflows?: Record<string, string>;
    /** The existing backend the workflows call: api.get/api.post paths are served against
     *  this base URL by restResources (tierless/adapt), forwarding the user's bearer token. */
    apiUrl?: string;
}
export interface TierlessPlugin {
    name: string;
    enforce: "pre";
    transform(code: string, id: string): {
        code: string;
        map: null;
    } | null;
    configResolved(config: {
        root?: string;
    }): void;
    buildStart(): void;
    writeBundle(): void;
    resolveId(id: string): string | undefined;
    load(id: string): string | undefined;
    transformIndexHtml: {
        order: "pre";
        handler(html: string): unknown;
    };
    configureServer(server: unknown): Promise<void>;
    configurePreviewServer(server: unknown): Promise<void>;
}
export default function tierless(opts?: TierlessPluginOptions): TierlessPlugin;
