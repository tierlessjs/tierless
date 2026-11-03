interface CompileOptions {
    /** Extra allow-list namespaces merged over { api: "server", commit: "browser" }. */
    resources?: Record<string, string>;
    filename?: string;
    preamble?: string;
    autoDeref?: boolean;
    autoWriteback?: boolean;
    trackWrites?: boolean;
    sourceMap?: boolean;
    /** Also compile async functions declared in a component or hook body (a top-level
     *  function) that make 2+ tier-reaching awaits — the loaders React apps write. */
    closures?: boolean;
    /** Make the SYNC closures a class method creates (`const t = (k) => this.translate(k)`)
     *  shippable values: each becomes a program over its caps (`this` included as
     *  `__self`), and the kept closure is a stub carrying both, which the codec ships as
     *  program + caps (graph.mts "fn") instead of leaving it behind as a handle. Every
     *  class in the module also gets a tier-independent identity (module hash + name,
     *  registered with shareClass), so a shipped instance rebuilds with its prototype on
     *  any tier that loads the module. */
    syncClosures?: boolean;
    /** Module code a component closure only CALLS — an import, a module-level function —
     *  is a free reference in its program (the gateway's bundle carries it: vite.mts bundles
     *  the import; browser-bound modules it drags in need `twinsStubs`), and an awaited
     *  call of one is a park the pump settles where the run is. true (the default): any
     *  import; a list: only imports from those sources (the Vite plugin passes the ones
     *  whose module graph is free of UI code); false: every outside binding captures, as
     *  before. Module-level functions and classes are free unless false. */
    moduleCode?: boolean | string[];
    /** Sync calls of VALUES (a captured function, a method of this or of a local) become
     *  pump-dispatched parks: a program runs as a sub-frame under the stop rule, a live
     *  function natively, a borrowed one at home. Module code stays a plain call. */
    syncCalls?: boolean;
    /** Every method of a top-level class compiles, tier calls or not — a library's methods
     *  as machines, runnable over a view of an instance. Sync methods keep their bodies. */
    syncMethods?: boolean;
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
