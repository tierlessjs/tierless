// Hand-written companion for conduit.gen.mjs (compiler OUTPUT, not hand-edited — see
// bench/conduit.src.js). Declares only what bench/conduit.mts actually imports.
import type { Frame, MachineResult } from "tierless/runtime";

export declare const PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
