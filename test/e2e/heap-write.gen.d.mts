// Hand-written companion for heap-write.gen.mjs (compiler OUTPUT, not hand-edited).
// Declares only what heap-write.mts actually imports.
import type { Frame, MachineResult } from "tierless/runtime";

export declare const PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
