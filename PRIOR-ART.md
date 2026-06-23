# Prior art — serialized continuations & durable/migratable computation

Reference notes for where Waso sits. Two questions matter: (1) does anyone
serialize a continuation to bytes and resume it elsewhere? (yes — several), and
(2) is anyone doing Waso's *specific* combination? (no). Plus one adjacent
family (replay) that solves a related-but-different problem and that we are
deliberately **not** using.

## A. Serialize-the-continuation (what Waso does)

Systems that capture execution state and move/persist it as data — the same
mechanism as Waso (design doc §4.2/§4.4).

| System | Substrate | What it serializes | Placement | Tiering |
|---|---|---|---|---|
| **Unison** (`Remote.transfer`) | own runtime | continuation + content-addressed code (ship bytecode, sync missing hashes) | explicit (`Remote` ability) | distributed, not client/server web |
| **GraalVM Espresso continuations** | JVM | a continuation to a byte array (Java serialization *or* Kryo) | n/a (suspend/resume, same machine) | none |
| **Racket web-server** | Racket | serializable continuation stuffed into a URL ("stuffers" = pluggable serializer) | n/a | single web server; client holds an opaque token, code stays server-side |
| **Golem Cloud** | WASM component model | program memory + execution state, "instruction-point precision," incremental deltas + oplog | n/a | failover/relocation, **not** client/server split |
| **NJS / "Aesop"** (our lineage) | CPS-transformed JS | the stack as a continuation object | inferred (the 2006 design) | client/server (the idea, pre-WASM) |
| Stackless Python; Apache Commons Javaflow | Python / JVM bytecode | pickleable tasklets / instrumented call stack | n/a | none |

Takeaways / what to steal:
- **Espresso's Kryo-vs-Java size result** (Kryo continuations ~half the size)
  validates our note to move the wire format off JSON to a compact binary.
- **Golem's incremental-delta snapshotting** is the reference for making capture
  cheap (don't re-serialize the whole state each time).
- **Racket's pluggable "stuffers"** seam matches our `waso-heap`/`waso-fetch`
  split — keep serialization swappable.
- **Unison's content-addressing** is the known answer to our open code-identity
  gotcha (resume-by-offset breaks under version skew; content-addressed code
  fixes it). Revisit when we tackle #5.

## B. Replay-from-a-log (the alternative we are NOT using)

The mainstream "durable execution" engines — **Temporal**, **Restate**, and the
lighter Postgres-backed **DBOS** — solve *resumable computation* WITHOUT
serializing a continuation. They event-source each step to a journal and, on
recovery, **re-execute deterministic code** against that log to reconstruct
state (Temporal "Event History", Restate "Journal"; DBOS commits each step
result to Postgres). This imposes a determinism constraint on workflow code
(no `Date.now()`, no ambient I/O outside logged steps).

**Why it doesn't fit Waso (yet):**
- Waso's core need is to move a *live* computation from one tier to another
  *mid-call* — ship the current stack across the wire and continue. Replay
  reconstructs state by re-running history; to "migrate" you'd replay the entire
  prior history on the other tier, and that history includes effects (DOM reads,
  client state) that can't be re-executed on the server. Replay gives you
  *resume-after-crash on a comparable host*, not *cross-tier transport now*.
- It also assumes deterministic, log-shaped workflows; Waso wants ordinary code
  with placement inferred from resources, not a workflow DSL.

**Where it might matter later (not now):** if a long-running migrated
computation needs to survive a crash, replay/journaling is the proven durability
story — and it's *orthogonal* to migration. So: noted, set aside. We are not
building on replay; serialization is the mechanism for the tier-migration need.

## C. Waso's unoccupied cell (design doc §9)

No system combines all of: **live continuation migration** + **placement
inferred from resource dependencies** (not declared) + **lazy placement** +
**client↔server tiering** + **JS/TS on WASM**. Each ingredient exists separately
(Unison = migration+content-addressing; RSC/Eliom = tiering; Golem = WASM state
snapshot for failover), but the combination is the open space Waso occupies.

## Sources
- GraalVM Espresso — Serialization of Continuations: https://www.graalvm.org/jdk25/reference-manual/espresso/continuations/serialization/
- Racket web-server — Stateless Servlets / serializable continuations: https://docs.racket-lang.org/web-server/stateless.html
- Golem — The Emerging Landscape of Durable Computing: https://golem.cloud/blog/the-emerging-landscape-of-durable-computing/
- Unveiling Golem Cloud: https://www.golem.cloud/post/unveiling-golem-cloud
- Demystifying Determinism in Durable Execution (Jack Vanlightly): https://jack-vanlightly.com/blog/2025/11/24/demystifying-determinism-in-durable-execution
- DBOS vs Temporal (2026): https://www.tiarebalbi.com/en/blog/dbos-vs-temporal-postgres-durable-execution
- Capturing and serializing continuations (knazarov): https://knazarov.com/posts/capturing_and_serializing_continuations/
