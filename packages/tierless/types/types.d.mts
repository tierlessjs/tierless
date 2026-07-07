/** One serializable continuation frame. */
export interface Frame {
    fn: string;
    pc: number;
    args: unknown[];
    ret?: unknown;
    [local: string]: unknown;
}
export type MachineResult = {
    op: "return";
    value: unknown;
} | {
    op: "call";
    fn: string;
    args: unknown[];
} | {
    op: "throw";
    value: unknown;
} | {
    op: "resource";
    tier: string;
    name: string;
    args: unknown[];
} | {
    op: "dyn";
    recv: unknown;
    member: string;
    args: unknown[];
};
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
/** Runs a continuation on the local tier until it finishes or parks at a foreign resource. */
export type Pump = (stack: Frame[], ownsHere: (tier: string) => boolean, execHere: Exec, incoming?: ResourceRequest | null) => Promise<{
    done: true;
    value: unknown;
} | {
    done: false;
    request: ResourceRequest;
    stack: Frame[];
}>;
/** The RPC peer from tierless/transport (structural — anything with request/on works). */
export interface Peer {
    request(payload: object, bin?: Uint8Array): Promise<{
        obj: any;
        bin: Uint8Array | null;
    }>;
    on(type: string, handler: (payload: any, bin: Uint8Array | null) => any): void;
    close(): void;
}
/** A host's answer to handleStart/handleResume — mirrors the wire protocol host.mts documents. */
export type HostReply = {
    type: "done";
    value: unknown;
} | {
    type: "suspend";
} | {
    type: "error";
    message: string;
};
export interface Host {
    pump: Pump;
    /** Start entry(...args) on THIS tier and drive it to completion with the peer.
     *  opts.trace forces (true) or suppresses (false) trace recording for this one run;
     *  absent = the host's sampling rate decides. */
    run(peer: Peer, entry: string, args?: unknown[], opts?: {
        trace?: boolean;
    }): Promise<unknown>;
    /** Ask the PEER to start entry(...args) over there; service any bounces back here. */
    call(peer: Peer, entry: string, args?: unknown[], opts?: {
        trace?: boolean;
    }): Promise<unknown>;
    /** Run entry(...args) entirely on THIS tier; foreign resources are FETCHED (only the
     *  request and result cross — the stack never ships). The frame may therefore hold
     *  unserializable values (live class instances, reactive proxies): the §6 fetch arm,
     *  and the path compiled class methods run on. A PINNED request — the family's
     *  declared semantics (opts.pins) or args closing over tier-owned values (callbacks,
     *  host objects) — executes here through opts.exec instead of crossing. opts.migrate
     *  flips a park to the migrate arm (docs/migrate-arm.md): the continuation ships to
     *  the resource's tier and comes home by the stop rule. */
    runLocal(peer: Peer, entry: string, args?: unknown[], opts?: {
        exec?: Exec;
        pins?: (req: ResourceRequest) => boolean;
        map?: (req: ResourceRequest) => ResourceRequest | null;
        migrate?: (req: ResourceRequest, site: {
            fn: string;
            pc: number;
        }) => boolean;
        trace?: boolean;
    }): Promise<unknown>;
    handleStart(payload: any, bin: Uint8Array | null, peer?: Peer): Promise<{
        obj: HostReply;
        bin?: Uint8Array;
    }>;
    handleResume(payload: any, bin: Uint8Array | null, peer?: Peer): Promise<{
        obj: HostReply;
        bin?: Uint8Array;
    }>;
    /** Serve one fetched resource for a peer's runLocal. */
    handleExec(payload: any, bin: Uint8Array | null): Promise<{
        obj: HostReply;
        bin?: Uint8Array;
    }>;
    answer(peer: Peer): Host;
}
