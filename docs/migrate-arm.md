# The §6 migrate arm for compiled methods

Status: design agreed, slice 1 in progress. The fetch arm (host.mts runLocal) stays the
default and the cold fallback; this document is the delta that lets a compiled method's
continuation MIGRATE to the server and run its request chain there — N crossings become 1.

## Why (measured)

The suite-at-the-socket runs (ports/vikunja/results/truth-*.jsonl, rtt80-*.jsonl):
bytes −35% median per test, trips −22% median — but wall time ±1% under real 80 ms RTT,
because every service call is still one crossing paying one RTT. Vikunja's
abstractService methods each make exactly ONE http call, so the chains that matter are
in callers (Pinia store closures: createNewTask → create + per-label create;
toggleFavorite → update + reload; project open → project/views/tasks). Slice 1 builds
the mechanics on class methods (the compiled surface we have); slice 3 widens the
compiled surface to those callers.

## The blocker the fetch arm dodged, solved with §5

A method frame holds live tier-owned values: `__self` (service instance — axios
instance, interceptor functions, sometimes a reactive proxy) and function locals
(`cancel` from setLoading). They cannot cross. The fetch arm's answer was "never ship
the frame". The migrate arm's answer is §5, applied by OWNERSHIP, not size:

- **Encode (leaving home):** any frame root that `ownsValues()` flags (functions,
  FormData/Blob — and therefore every service instance, via its interceptor functions)
  is excised into the local tier heap and crosses as a `{__tierless_handle__, owner, id}`
  leaf. The codec's handle slot tag and heap already exist (wire-binary.mts, heap.mts);
  what's new is excise-by-ownership (today's excision is size-threshold only).
- **Decode (coming home):** a handle whose `owner` is the local tier resolves back
  through `heap.get` to the SAME live object — master in place. The far side never
  resolves; it sees an opaque leaf.

## The pump rule: a segment may only run where its slots are real

The machine executes plain JS between parks — a segment that touches `__self` or
`cancel` cannot run on a tier where that slot is a handle, and sync code cannot suspend
mid-segment (design.md §8). So the check happens BEFORE the segment runs, in the pump:

- **Compiler metadata:** for each program, for each resume state, the set of frame
  slots the segment entered at that state references (computed on the LOWERED output —
  walk each switch case for identifiers naming frame slots). Emitted with PROGRAMS.
- **Pump stop rule:** before stepping a frame, if any slot referenced by the current
  state holds a handle → park with `{op:"home", tier: handle.owner}` and ship the stack
  there. The pump stays tier-agnostic: no configuration, the VALUES say where segments
  can run. This covers the normal path and error unwind identically (a catch/finally
  that calls `cancel()` parks home before executing — getAll's finally does exactly
  this).
- **Carry home:** the stack that parks home after a serviced request carries the value
  in `frame.ret` (already part of the encoded frame); ship `(stack, null)` — the
  existing resume path pumps straight on from `ret`. No new message type; no re-servicing.

## Protocol shape (no new messages)

Browser runLocal grows a migrate branch: at a park it may ship `(stack, request)` as a
`resume` to the gateway instead of exec-carrying. The gateway host — which for compiled
app modules today is EXEC_ONLY — gains the module's real machine (vite emits a server
bundle for compile targets into the dist-tierless manifest, as it always did for
workflow modules; §7 posture unchanged: the server runs its OWN build's code, incoming
stack state is untrusted data). The gateway pumps with the twin exec: http.* requests
service locally against the backend; when the pump hits the stop rule it ships the
stack home; `done` returns the value. Pinned requests (FormData, blob, progress
callbacks) never migrate — the ownership scan on the REQUEST already pins them to the
fetch-arm local path, unchanged.

## §6 decide (slice 2)

Cold default: fetch arm (stay put) — migrating on no evidence is the "effectively
infinite" cost of design.md §6. The trajectory machinery (trace.mts recorder, profile
artifact, decide()) prices the choice per call path: a path whose profile shows ≥2
server-priced resource touches before any home-parking segment migrates; everything
else keeps exec-carrying. Comparison runs use a locked profile; profiling runs, not
comparison runs, do the exploration (run protocol, docs/corpus.md).

## Slice plan

1. **Mechanics** (in progress): codec excise-by-ownership + decode-resolve-at-owner;
   compiler per-state slot metadata; pump stop rule; vite server emit for compiled app
   modules; browser migrate branch behind an explicit opt (no pricing yet). Proof: a
   fixture class whose method chains two http calls — 2 crossings → 1 — plus unwind
   (finally with a function local) and single-call parity, live over a real socket.
2. **decide()**: profile-driven fetch-vs-migrate at the park site; frozen for
   comparison runs.
3. **The app's real chains**: compile the Pinia store functions that orchestrate
   multi-call sequences (closures over reactive refs → §5 handles, same stop rule).
   This is where the RTT verdict should finally move.

## Slice-3 wall, found early: interceptor semantics for calls 2..N

The fetch arm runs the app's request-interceptor chain browser-side per request
(crossHttpRequest). A migrated chain's later calls park server-side, where those
closures don't exist — Vikunja's per-service interceptor (objectToSnakeCase on the
model) would be silently skipped and the backend would reject the write. Options,
in current order of preference: (a) apply the pure part of the chain in the twin
by importing the same helpers server-side (they're pure module functions in this
app); (b) compile the interceptor functions themselves; (c) pin write-bearing
requests to the fetch arm and migrate only read chains — the profile can encode
that per-site today. Slice 1's fixtures don't have interceptors; this decision
gates slice 3, not the mechanics.
