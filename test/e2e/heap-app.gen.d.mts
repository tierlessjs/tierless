// Hand-written companion for heap-app.gen.mjs (compiler OUTPUT, not hand-edited).
// Declares only what heap-live.mts actually imports.
import type { Frame, MachineResult } from "tierless/runtime";

export declare const PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
