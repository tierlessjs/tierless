// Hand-written companion for heap-auto.gen.mjs (compiler OUTPUT, not hand-edited).
// Declares only what heap-auto.mts actually imports.
import type { Frame, MachineResult } from "tierless/runtime";

export declare const PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
