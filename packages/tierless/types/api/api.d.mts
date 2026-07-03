export declare const PUBLIC: unique symbol;
export declare const DENY: unique symbol;
export type Principal = Record<string, unknown> | null;
export type Authorize = typeof PUBLIC | typeof DENY | ((principal: Principal, args: unknown[]) => boolean);
export interface FnDef {
    /** MANDATORY: who may call this, decided per call. PUBLIC / DENY / (principal, args) => boolean. */
    authorize: Authorize;
    run: (args: unknown[], principal: Principal) => unknown | Promise<unknown>;
}
export interface ApiOptions {
    /** Reject a call whose args serialize larger than this (bytes). */
    maxArgsBytes?: number;
    /** Per-principal sliding-window call budget. */
    rate?: {
        max: number;
        windowMs: number;
    };
}
export interface ApiCall {
    name: string;
    args?: unknown[];
    token?: string | null;
}
export type HandleResult = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    error: string;
};
export declare class Api {
    private _fns;
    private _audit;
    private _maxArgsBytes;
    private _rate;
    private _calls;
    private _lastSweep;
    constructor(opts?: ApiOptions);
    fn(name: string, def: FnDef): this;
    verify(_token: string | null): Principal | Promise<Principal>;
    handle(call: ApiCall | null | undefined): Promise<HandleResult>;
    private _allowRate;
    fns(): {
        name: string;
        authorize: "PUBLIC" | "DENY" | "per-call";
    }[];
    private _deny;
    private _log;
    audit(): {
        name: string;
        who: string | null;
        outcome: string;
    }[];
}
export interface ApiDef {
    create(secret: string | Uint8Array): JwtApi;
    opts: ApiOptions;
}
export declare function defineApi(build: Record<string, FnDef> | ((api: JwtApi) => Record<string, FnDef>), opts?: ApiOptions): ApiDef;
export declare class JwtApi extends Api {
    private _secret;
    constructor(secret: string | Uint8Array, opts?: ApiOptions);
    issue(principal: Record<string, unknown>, ttlSeconds?: number): string;
    verify(token: string | null): Principal;
    private _sign;
}
