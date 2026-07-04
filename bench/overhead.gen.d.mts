// Hand-written companion for overhead.gen.mjs (compiler OUTPUT, not hand-edited — see
// bench/overhead.src.js). Declares only what bench/overhead.mts actually imports.
import type { Frame, MachineResult } from "tierless/runtime";

export declare const PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
