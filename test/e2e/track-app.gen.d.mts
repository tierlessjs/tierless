// Hand-written companion for track-app.gen.mjs (compiler OUTPUT, not hand-edited — see
// test/e2e/track-app.src.js). Declares only what wire-delta-compiled.mts actually imports.
import type { Frame, MachineResult } from "tierless/runtime";

export declare const PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
export declare function __setDirtySink(fn: ((o: object) => void) | null): ((o: object) => void) | null;
