// tierless/heap — the §5 distributed handle heap (big data stays on its owning tier).
export function makeTier(name: string, opts?: object): any;
export function encodeWire(stack: unknown, request: object, tier?: any, opts?: object): any;
export function decodeWire(encoded: any, opts?: object): any;
export function wireHandles(encoded: any): any[];
export function writeBack(tier: any, handle: any, edited: unknown): { ok: boolean; version?: number };
export function commitWrite(tier: any, handle: any, edited: unknown, baseVersion: number): { ok: boolean; version?: number };
export function makeCoherentHost(tier: any, channel: any, opts?: object): any;
