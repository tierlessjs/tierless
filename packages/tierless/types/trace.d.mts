export declare function sampleTrace(id: string, rate: number): boolean;
export declare const mintTraceId: () => string;
/** The trace flag on the root frame — session state, so it rides the continuation. */
export interface TraceFlag {
    id: string;
    hop: number;
    seq: number;
    on: 1;
    entry?: string;
}
export type TraceRecord = 
/** One resource touch (inline-served or the one that forced a crossing), with its result size. */
{
    t: "res";
    id: string;
    hop: number;
    seq: number;
    fn: string;
    pc: number;
    resource: string;
    tier: string;
    argFeatures: string[];
    resultBytes: number;
    entry?: string;
}
/** One crossing: the continuation shipped (or was priced) at this site. choice is present once a §6 driver decides. */
 | {
    t: "hop";
    id: string;
    hop: number;
    seq: number;
    fn: string;
    pc: number;
    resource: string;
    contBytes: number;
    choice?: "migrate" | "fetch";
}
/** Run completion marker. A run id with no "end" record is truncated: usable for size models, excluded from trajectory statistics. */
 | {
    t: "end";
    id: string;
    hop: number;
    seq: number;
    outcome: "done" | "error";
};
export type TraceSink = (record: TraceRecord) => void;
/** Argument FEATURES, never values: numbers stay (they are structure — a row count), everything else reduces to type + size. */
export declare const argFeatures: (args: unknown[]) => string[];
/** Measure a resource result the way the fetch path would ship it: encoded bytes,
 *  not UTF-16 code units (non-ASCII payloads differ). -1 when unserializable. */
export declare const resultBytes: (v: unknown) => number;
export interface Recorder {
    /** The head-based sampling decision, made ONCE at spawn and immutable thereafter.
     *  Returns the run id when this spawn is traced, else null. `explicit` (a per-call
     *  {trace} option) overrides the force-list and the rate. */
    spawn(entry: string, explicit?: boolean): string | null;
    /** Stamp a root frame with a spawn decision's id (unconditional — the decision was spawn()'s). */
    stamp(stack: {
        [k: string]: unknown;
    }[], id: string, entry?: string): void;
    flagOf(stack: {
        [k: string]: unknown;
    }[]): TraceFlag | null;
    res(stack: {
        [k: string]: unknown;
    }[], req: {
        name: string;
        tier: string;
        args: unknown[];
    }, result: unknown): void;
    /** The continuation is crossing: bump the stack-carried counters FIRST (the shipped wire
     *  must carry them so the receiving tier's records sort after this one), then encode via
     *  the thunk, then sink the crossing record with the pre-bump ids and the exact shipped
     *  bytes. Untraced stacks just encode. */
    ship(stack: {
        [k: string]: unknown;
    }[], req: {
        name: string;
    }, encode: () => Uint8Array, choice?: "migrate" | "fetch"): Uint8Array;
    /** Run completion. Takes the FLAG (capture it with flagOf BEFORE pumping — a finished
     *  pump has popped every frame, so the stack no longer carries it). */
    end(flag: TraceFlag | null, outcome: "done" | "error"): void;
    /** Records dropped because the sink threw. Observability must never change the observed
     *  run's outcome, so a sink error is swallowed and counted, never propagated. */
    readonly dropped: number;
}
export interface RecorderOpts {
    rate?: number;
    force?: string[];
    sink: TraceSink;
}
export declare function makeRecorder({ rate, force, sink }: RecorderOpts): Recorder;
/** Collect records in memory (tests, small runs). Real deployments pass their own sink (e.g. JSONL appends). */
export declare function memorySink(): {
    sink: TraceSink;
    records: TraceRecord[];
};
export declare const siteKey: (fn: string, pc: number, resource: string) => string;
/** The method boundary's site: the same touch site, conditioned on the RUN's entry. */
export declare const entrySiteKey: (entry: string, fn: string, pc: number, resource: string) => string;
interface SizeBucket {
    n: number;
    mean: number;
}
export interface SiteProfile {
    n: number;
    sized: number;
    meanSize: number;
    sizes: Record<string, SizeBucket>;
    contMean: number;
    contN: number;
    /** Ordered same-tier suffix distributions observed after this site (complete runs only).
     *  fetchable=false marks a suffix that contained an unserializable result: the fetch path
     *  cannot traverse it AT ALL, so it must never be priced (a 0 would bias toward fetch —
     *  the wrong direction). fetchSum is the mean over the `priced` (fully fetchable)
     *  occurrences; n counts every occurrence (the shape statistics behind modal/stability). */
    suffixes: Record<string, {
        n: number;
        priced: number;
        fetchSum: number;
        fetchable: boolean;
    }>;
    modal: string | null;
    stability: number;
    complete: number;
}
export interface Profile {
    v: 1;
    bundle: string;
    runs: {
        total: number;
        complete: number;
    };
    sites: Record<string, SiteProfile>;
}
export declare function buildProfile(records: TraceRecord[], bundle: string): Profile;
/** Accept a profile only for the exact bundle it was traced against — a stale profile does
 *  not miss, it silently MISATTRIBUTES (a pc renumbered by an edit inherits another site's
 *  whole trajectory history). Mismatch ⇒ null ⇒ the greedy/cold floor. */
export declare function loadProfile(profile: Profile | null | undefined, bundleHash: string | undefined): Profile | null;
export interface Decision {
    choice: "migrate" | "fetch";
    why: string;
    fetchSide: number;
}
/** Expected result bytes for a site given the CURRENT call's argument features — the
 *  bucket if these features were seen before, else the site's overall mean. */
export declare function expectedFetch(s: SiteProfile, features: string[]): number;
export interface DecideOpts {
    /** false for a side-effecting resource: it can only be reached by migrating. */
    fetchable?: boolean;
    mode?: "greedy" | "trajectory";
    /** Minimum fraction of complete runs sharing the modal suffix before suffix pricing applies. */
    stability?: number;
    argFeatures?: string[];
}
export declare function decide(contBytes: number, key: string, profile: Profile | null, { fetchable, mode, stability, argFeatures }?: DecideOpts): Decision;
export interface MethodMigrateOpts {
    /** Minimum fraction of complete runs sharing the modal suffix (the same gate decide() uses). */
    stability?: number;
    /** How many MORE same-tier touches the modal suffix must hold. 1 = a two-call chain. */
    minSuffix?: number;
}
/** The §6 rule at a compiled METHOD's park (docs/migrate-arm.md slice 2) — the mirror
 *  image of decide()'s workflow rule. There, cold migrates: the continuation must reach
 *  its resources somehow, and fetch is the unpriced arm. Here, cold FETCHES: the fetch
 *  arm is free (the stack never ships) and migrating unpriced risks paying the shipping
 *  for a one-call method that bounces straight home. Migrate only on evidence: the
 *  profile — locked, from a profiling run, per the run protocol — shows this exact site
 *  (fn, pc, resource) starting a STABLE same-tier chain, each suffix touch a round trip
 *  the migration folds into one crossing. */
export declare function methodMigrate(profile: Profile | null, { stability, minSuffix }?: MethodMigrateOpts): (req: {
    name: string;
}, site: {
    fn: string;
    pc: number;
    entry?: string;
}) => boolean;
export {};
