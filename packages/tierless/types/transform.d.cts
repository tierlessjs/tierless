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
export interface FunctionReport {
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
