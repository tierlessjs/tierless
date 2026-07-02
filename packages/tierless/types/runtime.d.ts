// tierless/runtime — the tier-agnostic continuation driver.
import type { Bundle, Frame, Exec, ResourceRequest } from "./index.js";
export function initialStack(fn: string, args?: unknown[]): Frame[];
export function makePump(bundle: Bundle): (
  stack: Frame[],
  ownsHere: (tier: string) => boolean,
  execHere: Exec,
  incoming?: ResourceRequest | null,
) => Promise<{ done: true; value: unknown } | { done: false; request: ResourceRequest; stack: Frame[] }>;
export type { Bundle, Frame, Exec, ResourceRequest };
