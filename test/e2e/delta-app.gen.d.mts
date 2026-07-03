// Hand-written companion for delta-app.gen.mjs (compiler OUTPUT, not hand-edited).
// Declares only what delta-live.mts actually imports.
import type { Frame, MachineResult } from "tierless/runtime";

export declare const PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
export declare function __setDirtySink(fn: ((o: object) => void) | null): ((o: object) => void) | null;
