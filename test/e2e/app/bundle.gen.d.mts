// Hand-written companion for bundle.gen.mjs (compiler OUTPUT, not hand-edited — see
// test/e2e/app/App.src.js). Declares the full standard shape transform.cjs emits into every
// bundle (PROGRAMS + the single-tier run/start driver + the unwind helpers) — imported in
// different subsets by verify.mts, api-live.mts, demo.mts, and server-live.mts.
import type { Frame, MachineResult } from "tierless/runtime";

type StepResult =
  | { done: true; value: unknown }
  | { done: false; request: Extract<MachineResult, { op: "resource" }>; stack: Frame[] };

export declare const PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
export declare const isHandle: (x: unknown) => boolean;
export declare function __dispatch(F: Frame, err: unknown): number | null;
export declare function __unwindStep(F: Frame): number | null;
export declare function __unwind(stack: Frame[], err: unknown): boolean;
export declare function run(stack: Frame[]): StepResult;
export declare function start(fn: string, args?: unknown[]): StepResult;
