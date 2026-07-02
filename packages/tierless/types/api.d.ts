// tierless/api — the reference monitor (service side) + sidecar transport (host side).

export const PUBLIC: unique symbol;
export const DENY: unique symbol;

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
  rate?: { max: number; windowMs: number };
}

export class Api {
  constructor(opts?: ApiOptions);
  /** Register an endpoint. Omitting authorize throws HERE, at load time. */
  fn(name: string, def: FnDef): this;
  verify(token: string | null): Principal | Promise<Principal>;
  handle(call: { name: string; args?: unknown[]; token?: string | null }):
    Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  /** The registered surface for tooling: names + authorization KINDS only. */
  fns(): Array<{ name: string; authorize: "PUBLIC" | "DENY" | "per-call" }>;
  audit(): Array<{ name: string; who: string | null; outcome: string }>;
}

/** HMAC-SHA256 bearer-token regime. Swap regimes by subclassing Api and overriding verify(). */
export class JwtApi extends Api {
  constructor(secret: string | Uint8Array, opts?: ApiOptions);
  issue(principal: Record<string, unknown>, ttlSeconds?: number): string;
}

export interface ApiDef {
  create(secret: string | Uint8Array): JwtApi;
  opts: ApiOptions;
}

/** The whole trusted service as one literal. Pass a function to receive the created
 *  instance (e.g. a PUBLIC login minting tokens via api.issue). */
export function defineApi(
  build: Record<string, FnDef> | ((api: JwtApi) => Record<string, FnDef>),
  opts?: ApiOptions,
): ApiDef;

export interface SidecarClient {
  ready(): Promise<void>;
  call(name: string, args?: unknown[], token?: string | null):
    Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  close(): void;
}

/** Fork a service module as a reference-monitor sidecar in its own OS process. */
export function startSidecar(entryUrl: URL | string, env?: Record<string, string>): SidecarClient;

/** Child side: serve an Api over the fork IPC pipe. */
export function serve(api: Api): void;

/** Fork entry, as a tail call in the service module: no-op on normal import;
 *  when forked it runs init, mints the secret in-process, and serves the pipe. */
export function sidecarMain(apiDef: ApiDef | ((secret: string | Uint8Array) => Api), opts?: { init?: () => void }): boolean;

/** The DEFAULT execHere for the server tier: forward { name, args, token } to the
 *  monitor; a denial becomes a throw that unwinds into the continuation. */
export function makeApiExec(
  client: SidecarClient | { call: SidecarClient["call"] },
  token?: string | null,
): (req: { name: string; args: unknown[] }) => Promise<unknown>;
