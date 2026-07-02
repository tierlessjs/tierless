// tierless — the session host both tiers share.

/** A compiled bundle (transform.cjs output): named state machines + the frame unwinder. */
export interface Bundle {
  PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
  __unwind: (stack: Frame[], err: unknown) => boolean;
  [key: string]: unknown;
}

/** One serializable continuation frame. */
export interface Frame {
  fn: string;
  pc: number;
  args: unknown[];
  ret?: unknown;
  [local: string]: unknown;
}

export type MachineResult =
  | { op: "return"; value: unknown }
  | { op: "call"; fn: string; args: unknown[] }
  | { op: "throw"; value: unknown }
  | { op: "resource"; tier: string; name: string; args: unknown[] };

/** A tier-pinned resource request handed to `exec`. */
export interface ResourceRequest {
  op: "resource";
  tier: string;
  name: string;
  args: unknown[];
}

export type Exec = (req: ResourceRequest) => unknown | Promise<unknown>;

/** The RPC peer from tierless/transport (structural — anything with request/on works). */
export interface Peer {
  request(payload: object, bin?: Uint8Array): Promise<{ obj: any; bin: Uint8Array | null }>;
  on(type: string, handler: (payload: any, bin: Uint8Array | null) => any): void;
  close(): void;
}

export interface Host {
  pump(stack: Frame[], ownsHere: (tier: string) => boolean, execHere: Exec, incoming?: ResourceRequest | null):
    Promise<{ done: true; value: unknown } | { done: false; request: ResourceRequest; stack: Frame[] }>;
  /** Start entry(...args) on THIS tier and drive it to completion with the peer. */
  run(peer: Peer, entry: string, args?: unknown[]): Promise<unknown>;
  /** Ask the PEER to start entry(...args) over there; service any bounces back here. */
  call(peer: Peer, entry: string, args?: unknown[]): Promise<unknown>;
  handleStart(payload: any, bin: Uint8Array | null): Promise<{ obj: any; bin?: Uint8Array }>;
  handleResume(payload: any, bin: Uint8Array | null): Promise<{ obj: any; bin?: Uint8Array }>;
  answer(peer: Peer): Host;
}

export function makeHost(opts: {
  bundle: Bundle;
  tier: string;
  exec: Exec;
  owns?: (tier: string) => boolean;
  meta?: Record<string, unknown>;
}): Host;

/** Route peer messages to one of several hosts by a payload field (default "module"). */
export function answerWith(peer: Peer, hostFor: (id: string) => Host | Promise<Host>, field?: string): void;
