// stackmix/compiler — the transform as an importable library (CommonJS).

export interface CompileOptions {
  /** Extra allow-list namespaces merged over { api: "server", commit: "browser" }. */
  resources?: Record<string, string>;
  filename?: string;
  preamble?: string;
  autoDeref?: boolean;
  autoWriteback?: boolean;
  trackWrites?: boolean;
  sourceMap?: boolean;
}

export interface CompileMeta {
  programs: string[];
  /** Exported suspendable functions — the module's actions surface. */
  exported: string[];
  pure: string[];
}

export function compile(src: string, opts?: CompileOptions): { code: string; meta: CompileMeta };

export interface FunctionReport {
  name: string;
  exported: boolean;
  suspendable: boolean;
  direct: boolean;
  suspensions: Array<{ name: string; tier: string; line: number | null }>;
  callsSuspendable: string[];
}

export function analyze(src: string, opts?: CompileOptions): {
  functions: FunctionReport[];
  resources: Record<string, string>;
};

export const DEFAULT_RESOURCES: Record<string, string>;
