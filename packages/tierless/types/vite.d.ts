// tierless/vite — the Vite plugin: "use tierless" modules become monitor-backed actions.

export interface TierlessPluginOptions {
  /** Path to the trusted service module (forked as a reference-monitor sidecar). */
  api?: string;
  /** Demo session: log in once per connection with these credentials, carry the token. */
  login?: { user: string; pass: string } | null;
  /** Extra allow-list namespaces, merged over the api/commit defaults (e.g. { db: "server" }). */
  resources?: Record<string, string>;
  /** Import specifier for the browser host in emitted modules (test override). */
  runtime?: string;
  /** Session endpoint path (defaults to WS_PATH). */
  path?: string;
  /** Passed through to the compiler (trackWrites, sourceMap, …). */
  compilerOptions?: Record<string, unknown>;
}

/** A plain Vite-compatible plugin object (transform + configureServer). */
export default function tierless(opts?: TierlessPluginOptions): {
  name: string;
  enforce: "pre";
  transform(code: string, id: string): { code: string; map: null } | null;
  configureServer(server: unknown): Promise<void>;
};
