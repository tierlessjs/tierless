// tierless/compiler — the transform as an importable library (CommonJS).
//
// transform.cjs is compiled from transform.cts (see src/transform.cts), so CompileOptions/
// CompileMeta/FunctionReport below are the real, implementation-linked shapes -- imported from
// the auto-generated types/transform.d.cts, not hand-duplicated. Only this file's own top-level
// bindings (compile/analyze/DEFAULT_RESOURCES) are hand-written: transform.cts's module.exports
// assignment is plain CommonJS, which .cts + verbatimModuleSyntax can't auto-declare as named
// exports (only `export interface`/`export type` — type-only, fully erased -- are allowed to
// coexist with it).
import type { CompileOptions, CompileMeta, FunctionReport } from "./transform.cjs";
export type { CompileOptions, CompileMeta, FunctionReport };

export function compile(src: string, opts?: CompileOptions): { code: string; meta: CompileMeta };
export function analyze(src: string, opts?: CompileOptions): {
  functions: FunctionReport[];
  resources: Record<string, string>;
};
export const DEFAULT_RESOURCES: Record<string, string>;
