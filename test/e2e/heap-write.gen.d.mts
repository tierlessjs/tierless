// Hand-written companion for heap-write.gen.mjs (compiler OUTPUT, not hand-edited).
// Declares what heap-write.mts / heap-serve.mts import.
import type { Frame, MachineResult } from "tierless/runtime";

export declare const PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
export declare function __unwind(stack: Frame[], err: unknown): boolean;
export declare const isHandle: (x: unknown) => boolean;   // present because compiled with --auto-deref --auto-writeback
