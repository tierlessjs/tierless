interface CompileOptions {
    /** Extra allow-list namespaces merged over { api: "server", commit: "browser" }. */
    resources?: Record<string, string>;
    filename?: string;
    preamble?: string;
    autoDeref?: boolean;
    autoWriteback?: boolean;
    trackWrites?: boolean;
    sourceMap?: boolean;
}
interface CompileMeta {
    programs: string[];
    /** Exported suspendable functions — the module's actions surface. */
    exported: string[];
    pure: string[];
    /** Top-level relative import/export-from specifiers, in source form (for server-emit rewriting). */
    imports: string[];
}
interface FunctionReport {
    name: string;
    exported: boolean;
    suspendable: boolean;
    direct: boolean;
    suspensions: Array<{
        name: string;
        tier: string;
        line: number | null;
    }>;
    callsSuspendable: string[];
}
declare function compileModule(src: string, opts?: CompileOptions): {
    code: string;
    meta: CompileMeta;
};
declare function analyze(src: string, opts?: CompileOptions): {
    functions: FunctionReport[];
    resources: Record<string, string>;
};
declare const _default: {
    compile: typeof compileModule;
    analyze: typeof analyze;
    DEFAULT_RESOURCES: Record<string, string>;
};
export = _default;
