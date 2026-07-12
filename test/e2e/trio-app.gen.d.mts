// Hand-written companion for trio-app.gen.mjs (compiler OUTPUT, not hand-edited).
// Declares only what trio-live.mts actually imports.
import type { Frame, MachineResult } from "tierless/runtime";

export declare const PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
export declare function __unwind(stack: Frame[], err: unknown): boolean;
export declare const BUNDLE_HASH: string;
