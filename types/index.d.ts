// Type declarations for the Stackmix public API (the `#stackmix` / `stackmix`
// entry point, src/index.mjs). The runtime itself is authored in JavaScript;
// these hand-written declarations are the supported, stable type surface.

// --- IR & continuations ------------------------------------------------------

/** A single IR instruction: an opcode string followed by its operands. */
export type Instruction = [string, ...unknown[]];

/** A source position attached to an IR instruction (for stack traces). */
export interface SourcePos {
  file: string;
  line: number;
  col: number;
  text?: string;
}

/** The compiled form of one function. */
export interface FnIR {
  nlocals: number;
  code: Instruction[];
  /** Per-instruction source positions, when compiled from TypeScript. */
  pos?: (SourcePos | null)[];
}

/** A program: a registry mapping function name to its compiled IR. */
export interface Program {
  [fn: string]: FnIR;
}

/** One live call frame in a continuation. */
export interface Frame {
  fn: string;
  ip: number;
  locals: unknown[];
  stack: unknown[];
  env: unknown[];
  handlers: Array<{ ip: number; sp: number }>;
  thisVal?: unknown;
}

/** What a suspended continuation is waiting on at a boundary. */
export type Pending =
  | { name: string; args: unknown[] }          // a resource the current tier lacks
  | { await: unknown }                          // a genuine async value
  | { fetch: Handle }                           // a remote-handle deref miss
  | null;

/** A captured continuation: the live frame stack plus what it is waiting on. */
export interface Continuation {
  frames: Frame[];
  pending: Pending;
}

/** The serialized, transport-ready form of a continuation. */
export interface Wire {
  frames: unknown[];
  pending: unknown;
  graph: { roots: number[]; objs: unknown[] };
}

/** An opaque reference to a subgraph that stayed resident on another tier (§5). */
export interface Handle {
  __stackmix_handle__: true;
  owner: string;
  id: string;
  bytes: number;
}

// --- Tiers & hosts -----------------------------------------------------------

/** A resource implementation: receives the call's arguments, returns a value. */
export type Resource = (args: any[]) => unknown;

/** An isolated execution context: its own resource imports and heap. */
export declare class Tier {
  constructor(id: string, resources: Record<string, Resource>);
  id: string;
  resources: Record<string, Resource>;
  heap: Map<string, unknown>;
  has(name: string): boolean;
  heapPut(obj: unknown): string;
  heapGet(id: string): unknown;
}

/** Resolves a §5 handle — locally, or by fetching from the owning tier. */
export interface Host {
  deref(handle: Handle): unknown | Miss;
}

/** The outcome of running frames to completion. */
export interface RunResult {
  type?: "done";
  value: unknown;
}

// --- Runtime -----------------------------------------------------------------

/** Options for compiling a single TypeScript module into a runtime. */
export interface LoadOptions {
  entry?: string;
  resources?: string[];
  file?: string;
}

/** Options for compiling a multi-file import graph into a runtime. */
export interface LoadProgramOptions {
  entry?: string;
  entryFile?: string;
  resources?: string[];
}

/** One entry in a human-readable continuation stack trace. */
export interface TraceEntry {
  depth: number;
  fn: string;
  loc: SourcePos | null;
}

/**
 * An isolated runtime: a program registry plus the interpreter and the
 * TypeScript frontend bound to it. Two runtimes never share state.
 */
export interface Runtime {
  /** The raw program registry (advanced use; prefer the methods below). */
  program: Program;
  /** Compile a single TypeScript module into this runtime. */
  load(source: string, opts?: LoadOptions): Program;
  /** Compile a multi-file import graph (Map<path, source>) into this runtime. */
  loadProgram(files: Map<string, string>, opts?: LoadProgramOptions): Program;
  /** Install hand-written IR under `name`. */
  define(name: string, ir: FnIR): FnIR;
  /** Run `frames` on `tier` until they return or suspend at a boundary. */
  run(tier: Tier | { id: string }, frames: Frame[], host: Host): RunResult;
  /** A source-mapped stack trace for a frame stack. */
  describe(frames: Frame[]): TraceEntry[];
  /** Forget all loaded code. */
  reset(): Runtime;
}

/** Create an isolated runtime. */
export declare function createRuntime(): Runtime;

// --- Runtime primitives ------------------------------------------------------

export declare function run(
  program: Program,
  tier: Tier | { id: string },
  frames: Frame[],
  host: Host,
): RunResult;

/** Raised out of the interpreter when a resource boundary forces a migration. */
export declare class Suspend {
  constructor(frames: Frame[], pending: Pending);
  frames: Frame[];
  pending: Pending;
}

/** Returned by `Host.deref` when a remote handle is not resident locally. */
export declare class Miss {
  constructor(handle: Handle);
  handle: Handle;
}

/** Thrown when a Stackmix `throw` unwinds past every frame. */
export declare class StackmixUncaught {
  constructor(value: unknown);
  value: unknown;
}

/** Internal control signal: a generator `yield`. */
export declare class Yielded {
  constructor(value: unknown);
  value: unknown;
}

export declare function serializeContinuation(cont: Continuation, sourceTier: Tier): Wire;
export declare function deserializeContinuation(wire: Wire): Continuation;
export declare function contBytes(wire: Wire): number;
export declare function pendingName(wire: Wire): string | undefined;
export declare function wireHandles(wire: Wire): string[];
export declare function initialFrames(entry: string, args: unknown[]): Frame[];
export declare function padLocals(args: unknown[], n: number): unknown[];

export declare function isHandle(x: unknown): x is Handle;
export declare function isGenerator(x: unknown): boolean;
export declare function isClosure(x: unknown): boolean;
export declare function awaitable(payload: unknown): { __stackmix_async__: true; payload: unknown };

/** Format a byte count as B / KB / MB. */
export declare function fmt(bytes: number): string;

/** Subgraphs larger than this become §5 handles instead of being copied. */
export declare const HANDLE_THRESHOLD: number;

// --- Wire / heap / transport -------------------------------------------------

export declare function encodeGraph(
  values: unknown[],
  opts?: { tier?: Tier | null; threshold?: number },
): { roots: number[]; objs: unknown[] };
export declare function decodeGraph(graph: { roots: number[]; objs: unknown[] }): unknown[];

export declare function writeFrame(stream: NodeJS.WritableStream, obj: unknown, bin?: Buffer): number;
export declare function readFrames(
  stream: NodeJS.ReadableStream,
  onFrame: (msg: any, bin: Buffer, len: number) => void,
): void;

export declare class Heap {
  put(obj: unknown): string;
  get(id: string): unknown;
}
export declare class Channel {
  constructor(...args: any[]);
}
export declare function makeHost(localTier: Tier, channel: Channel): Host;

// --- Compiler (TypeScript -> Stackmix IR) ------------------------------------

export declare function compileModule(source: string, opts?: LoadOptions): Program;
export declare function compileProgram(files: Map<string, string>, opts?: LoadProgramOptions): Program;
export declare function loadModule(program: Program, source: string, opts?: LoadOptions): Program;
export declare function loadProgram(program: Program, files: Map<string, string>, opts?: LoadProgramOptions): Program;
export declare function describeContinuation(program: Program, frames: Frame[]): TraceEntry[];
