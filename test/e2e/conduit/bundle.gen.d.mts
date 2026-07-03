// Hand-written companion for bundle.gen.mjs (compiler OUTPUT, not hand-edited — see
// test/e2e/conduit/App.src.js). Declares only what conduit-verify.mts actually imports.
import type { Frame, MachineResult } from "tierless/runtime";

type StepResult =
  | { done: true; value: unknown }
  | { done: false; request: Extract<MachineResult, { op: "resource" }>; stack: Frame[] };

export declare function __unwind(stack: Frame[], err: unknown): boolean;
export declare function run(stack: Frame[]): StepResult;
export declare function start(fn: string, args?: unknown[]): StepResult;
