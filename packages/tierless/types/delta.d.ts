// tierless/delta — the delta wire: ship a capture as a patch over what the peer holds.
export function makeDeltaSession(opts?: object): any;
export function makeTrackedSession(opts?: object): any;
export function touch(session: any, obj: object): void;
export function encodeDelta(session: any, roots: unknown, opts?: object): Uint8Array;
export function encodeDeltaTracked(session: any, roots: unknown, opts?: object): Uint8Array;
export function applyDelta(session: any, bin: Uint8Array): unknown;
export function applyDeltaTracked(session: any, bin: Uint8Array): unknown;
export function planDelta(session: any, roots: unknown, opts?: object): any;
export function adoptBaseline(session: any, roots: unknown, opts?: object): void;
export function subForFullWire(session: any, roots: unknown, opts?: object): unknown;
export function exciseForCapture(session: any, roots: unknown, opts?: object): unknown;
export function openSnapshot(session: any, value: unknown): unknown;
export function diffSnapshot(session: any, value: unknown): Uint8Array | null;
export function wholeSnapshot(value: unknown): Uint8Array;
export function applySnapshot(target: unknown, bin: Uint8Array): unknown;
