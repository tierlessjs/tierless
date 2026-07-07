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
    /** Per-method outcome for top-level classes: compiled into `program`, or kept
     *  original with the blocking `error`. Methods without tier calls aren't listed. */
    methods: Array<{
        class: string;
        method: string;
        program: string | null;
        error?: string;
    }>;
    /** MACHINE-ONLY server module for class-method compilation (docs/migrate-arm.md): the
     *  programs, module-level helper functions, and ONLY the imports machine code actually
     *  references — the kept classes and their construction-time graph (http factories,
     *  framework wiring) stay out, so the module loads in plain Node. The migrate arm's
     *  gateway resolves this; absent when no class method compiled. */
    serverCode?: string;
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
