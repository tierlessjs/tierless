# Memory management — the §5 heap's retention surfaces

What bounds resident memory on the live path today, and the spec for the three pieces
that remain. Behavioral claims here are verified by tests in the tree
(`test/e2e/evict-safety.mts`, `test/e2e/heap-serve.mts`).

## Bounded today

A connection that uses the §5 heap (`--auto-deref`) gets a per-connection `Coherence`
(`coherence.mts`): one heap for excised locals, one reader cache for fetched snapshots.

- **Reader deref cache** — a byte-weighted LRU (`store.mts` `makeLruStore`), default
  64 MiB per connection (`DEFAULT_CACHE_BYTES`). Safe to evict: the master lives on the
  owner tier, so an eviction costs at most a refetch, never a lost or stale value. The
  policy is replaceable: the store interface is `get`/`set`/`evict` (possibly-async), and
  a different store or budget can be injected per connection.
- **Everything per-connection** — the coherence object lives in the socket's `connection`
  closure (`server.mts`), so a disconnect frees all of it.

Neither the server nor the framework caps connection count; the OS does (file
descriptors, RAM). Worst-case reader-cache memory is `budget x open connections`.

## Not yet bounded (within a session) — the remaining spec

### 1. The write-back path is not served — `@writeback`

`--auto-writeback` compiles a mutation into `{tier:"@writeback", name:"writeback"}`. The
live host serves `@deref` but not `@writeback`. Verified by execution (an
`--auto-writeback` bundle through the real host over a real socket): the session
**rejects at the first write and the write is lost** — the master is never updated.
Without a guard the request migrated into the *other* tier's app exec and died as a
baffling `no resource writeback`; the host now fails closed at the tier that hit it, with
a diagnostic naming this document (`host.mts`, proven in `heap-serve.mts` Part 5).

Static detection can't gate this earlier: an `--auto-writeback` bundle's exports are
identical to an `--auto-deref` one's (`isHandle` is the only marker), so the compiler
should also export a write-back marker; until then the runtime guard is the gate.

To build: mirror `@deref`. The host owns `@writeback` and services it by proposing the
mutated snapshot back to the owner over the same socket under an optimistic CAS. The CAS
and min(delta, whole) logic already exist against the in-process test channel (`heap.mts`
`writeBack`, `commitWrite`, `makeCoherentHost.writeBack`); lift them to the peer exactly
as `@deref` was lifted. Prove with an `--auto-writeback` app through `serveApp`/`connect`:
a browser edit propagates to the server master over the socket.

### 2. Write-back baselines — reader-side, evict only when clean

A minimal-delta write-back needs a baseline snapshot per fetched-for-write object
(`openSnapshot`). The hazard, verified in the original design work: with the baseline
missing, `writeBack` returns without applying — the mutation is silently dropped. So a
baseline may be evicted only when its object is **clean** (never dirtied, or already
written back); a dirty baseline is pinned until its write-back completes or the session
ends.

Build: dirty/clean tracking plus a pinning byte-LRU (an LRU whose eviction skips pinned
entries) on the baseline store. The store interface already permits a separate policy per
namespace — that separation exists precisely so the baselines never share the deref
cache's evict-freely policy. Regression: a long write session stays bounded while no
dirty write is ever lost.

### 3. The owner-side excision heap — release per continuation

`Heap.put` is set-only. Every big local a tier excises on the outbound wire lands in the
connection's heap and stays until disconnect — the **owner** accumulates a copy of every
excised local. A naive cap is unsafe: evicting a live excised local strands any reader
that later derefs its handle.

Bounding needs liveness, coarse to precise:

- (a) **Per-connection release** — in place today (the per-socket closure).
- (b) **Per-continuation release** — recommended next: tag each excised id with the
  continuation that created it, and drop those ids when it completes (the host already
  has the completion point — `drive` resolving / `onDone`). Bounds a long-lived
  connection running many sequential sessions. Regression: N sequential deref sessions
  keep the owner heap flat, not O(N).
- (c) **Reference counting / liveness tracing** — precise, GC-hard; defer unless (b)
  proves insufficient.

## Build order

1. Serve `@writeback` (peer-backed CAS write-back; replaces the fail-closed guard).
2. Clean-state-gated baseline eviction (needs 1 to be exercisable end-to-end).
3. Per-continuation owner-heap release (independent of 1 and 2).
