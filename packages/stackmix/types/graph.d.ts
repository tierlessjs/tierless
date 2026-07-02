// stackmix/graph — identity/cycle-safe graph codec (the readable JSON form of the wire).
export function encodeGraph(roots: unknown[], opts?: object): any;
export function decodeGraph(encoded: any, opts?: object): unknown[];
export function isHandle(x: unknown): boolean;
export function approxExceeds(value: unknown, threshold: number): boolean;
export const GLOBALS: Map<string, unknown>;
export const CTORS: Record<string, unknown>;
