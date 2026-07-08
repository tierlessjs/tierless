// Shared vocabulary for the session host: what a compiled bundle looks like, what a
// continuation frame carries, what the pump yields, and the peer/host RPC shapes that tie
// a session together across the wire. Pure types, no runtime code — every module that
// needs them imports `type {...}` from here, so this file compiles to nothing and adds no
// runtime coupling. Not in the package's exports map; consumers get these re-exported from
// the modules that actually use them (tierless, tierless/runtime, tierless/browser, ...).

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
  | { op: "resource"; tier: string; name: string; args: unknown[] }
  // the DYNAMIC call park (docs/migrate-arm.md slice 3): an awaited member call whose
  // meaning the PUMP resolves — a session twin's method (class-stamped handle), a
  // nested machine (stamped stub), or a plain promise settled in place. Never crosses
  // a wire as-is; only its consequences do.
  | { op: "dyn"; recv: unknown; member: string; args: unknown[] };

/** A compiled bundle (transform.cjs output): named state machines + the frame unwinder. */
export interface Bundle {
  PROGRAMS: Record<string, (frame: Frame) => MachineResult>;
  __unwind: (stack: Frame[], err: unknown) => boolean;
  [key: string]: unknown;
}

/** A tier-pinned resource request handed to `exec`. op "home" is the §5 stop rule's park
 *  marker (docs/migrate-arm.md): the stack must go to `tier` — where the handle in slot
 *  `name` lives — before its next segment can run. It is never handed to an exec. */
export interface ResourceRequest {
  op: "resource" | "home";
  tier: string;
  name: string;
  args: unknown[];
}

export type Exec = (req: ResourceRequest) => unknown | Promise<unknown>;

/** A twin call's observable effect on instance state (docs/migrate-arm.md): the fields
 *  the twin mutated, addressed by the receiver HANDLE so the home tier can apply them to
 *  the live instance before the awaiting code resumes — read-your-writes at method
 *  return, carried on the crossing that was already coming home. Field values ride the
 *  reply's JSON payload, so they must be JSON-safe (true of instance counters/flags;
 *  a Date-valued field would come home as its ISO string). */
export interface TwinDelta { owner: string; id: string; fields: Record<string, unknown> }

/** Runs a continuation on the local tier until it finishes or parks at a foreign resource. */
export type Pump = (
  stack: Frame[],
  ownsHere: (tier: string) => boolean,
  execHere: Exec,
  incoming?: ResourceRequest | null,
  sink?: { twinDelta(d: TwinDelta): void },
) => Promise<{ done: true; value: unknown } | { done: false; request: ResourceRequest; stack: Frame[] }>;

/** The RPC peer from tierless/transport (structural — anything with request/on works). */
export interface Peer {
  request(payload: object, bin?: Uint8Array): Promise<{ obj: any; bin: Uint8Array | null }>;
  on(type: string, handler: (payload: any, bin: Uint8Array | null) => any): void;
  close(): void;
}

/** A host's answer to handleStart/handleResume — mirrors the wire protocol host.mts documents. */
export type HostReply =
  | { type: "done"; value: unknown; twinDeltas?: TwinDelta[] }
  | { type: "suspend"; twinDeltas?: TwinDelta[] }
  | { type: "error"; message: string };

export interface Host {
  pump: Pump;
  /** Start entry(...args) on THIS tier and drive it to completion with the peer.
   *  opts.trace forces (true) or suppresses (false) trace recording for this one run;
   *  absent = the host's sampling rate decides. */
  run(peer: Peer, entry: string, args?: unknown[], opts?: { trace?: boolean }): Promise<unknown>;
  /** Ask the PEER to start entry(...args) over there; service any bounces back here. */
  call(peer: Peer, entry: string, args?: unknown[], opts?: { trace?: boolean }): Promise<unknown>;
  /** Run entry(...args) entirely on THIS tier; foreign resources are FETCHED (only the
   *  request and result cross — the stack never ships). The frame may therefore hold
   *  unserializable values (live class instances, reactive proxies): the §6 fetch arm,
   *  and the path compiled class methods run on. A PINNED request — the family's
   *  declared semantics (opts.pins) or args closing over tier-owned values (callbacks,
   *  host objects) — executes here through opts.exec instead of crossing. opts.migrate
   *  flips a park to the migrate arm (docs/migrate-arm.md): the continuation ships to
   *  the resource's tier and comes home by the stop rule. */
  runLocal(peer: Peer, entry: string, args?: unknown[], opts?: { exec?: (req: ResourceRequest, frame?: Frame) => unknown | Promise<unknown>; pins?: (req: ResourceRequest) => boolean; map?: (req: ResourceRequest, frame?: Frame) => ResourceRequest | null; migrate?: (req: ResourceRequest, site: { fn: string; pc: number; entry?: string }) => boolean; trace?: boolean }): Promise<unknown>;
  // `peer` is the socket the message arrived on; the host services any §5 deref back over
  // it (needed only when heap coherence is configured — omit it and derefs aren't served).
  handleStart(payload: any, bin: Uint8Array | null, peer?: Peer): Promise<{ obj: HostReply; bin?: Uint8Array }>;
  handleResume(payload: any, bin: Uint8Array | null, peer?: Peer): Promise<{ obj: HostReply; bin?: Uint8Array }>;
  /** Serve one fetched resource for a peer's runLocal. */
  handleExec(payload: any, bin: Uint8Array | null): Promise<{ obj: HostReply; bin?: Uint8Array }>;
  answer(peer: Peer): Host;
}
