import type { DeltaFrame, DeltaRequest } from "./wire-delta.mjs";
export declare class W {
    buf: Uint8Array;
    n: number;
    constructor();
    ensure(k: number): void;
    u8(b: number): void;
    raw(bytes: Uint8Array): void;
    varu(x: number): void;
    vari(x: number): void;
    f64(x: number): void;
    done(): Uint8Array;
}
export declare class R {
    buf: Uint8Array;
    n: number;
    len: number;
    dv: DataView;
    label: string;
    constructor(buf: Uint8Array, label: string);
    need(k: number): void;
    u8(): number;
    raw(k: number): Uint8Array;
    varu(): number;
    count(): number;
    vari(): number;
    f64(): number;
}
export declare const isVarInt: (v: number) => boolean;
export declare const writeMagic: (w: W, magic: string) => void;
export declare const checkMagic: (r: R, magic: string) => void;
export declare const makeInterner: () => {
    strs: string[];
    intern: (s: string) => number;
};
export declare const writeStrings: (w: W, strs: string[]) => void;
export declare const readStrings: (r: R) => string[];
export declare const strAt: (strs: string[], label: string) => (i: number) => string;
export interface RootFrame {
    fn: string;
    pc: number;
    keys: string[];
    b0: number;
}
export interface RootReq {
    op: string;
    tier: string;
    name: string;
    a0: number;
    argc: number;
}
export declare function rootsOf(stack: DeltaFrame[], request: DeltaRequest | null): {
    rootVals: unknown[];
    frames: RootFrame[];
    req: RootReq | null;
};
export declare function rebuildStack(frames: RootFrame[], req: RootReq | null, vals: unknown[]): {
    stack: DeltaFrame[];
    request: DeltaRequest | null;
};
export declare function writeFrameHeader(w: W, frames: RootFrame[], req: RootReq | null, intern: (s: string) => number): void;
export declare function readFrameHeader(r: R, S: (i: number) => string): {
    frames: RootFrame[];
    req: RootReq | null;
};
