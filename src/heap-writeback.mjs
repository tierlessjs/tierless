// Headless probe: §5 WRITE-BACK coherence (optimistic, version-checked CAS).
//
// v1 was single-writer (readers held snapshots and never wrote). This proves the write
// path. A reader fetches a snapshot of a master object, mutates it, and proposes it back
// under the version it read. The master (the owning tier) is the sole serialization point:
// it accepts the write only if no one bumped the version in between, so a STALE write is
// rejected as a conflict and the writer must refetch (now seeing the winner's change),
// re-apply, and retry. No lost updates — the CAS guarantee applied to a fetched §5
// snapshot. Reuses the project's Heap/Channel and the identity/cycle-safe graph codec.
import { makeTier, Channel, writeBack, commitWrite } from "./heap.mjs";

let pass = true;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); pass = pass && cond; };
console.log("Probe: §5 write-back — a reader's mutation propagates back to the master under optimistic CAS\n");

const server = makeTier("server"), browser = makeTier("browser");
const channel = new Channel({ server, browser });

// --- A) the CAS primitive: two writers, conflict detection, refetch + retry ------------
// A shared doc lives on the server (the master); the browser side is a remote writer.
const handle = server.heap.put({ title: null, author: null });
const master = () => server.heap.get(handle.id);

// Two readers each grab the same v1 snapshot (both fetched before either wrote).
const a = channel.fetch(handle);   // { copy, version: 1 }
const b = channel.fetch(handle);   // { copy, version: 1 }
check("both readers fetched the same base version (v1)", a.version === 1 && b.version === 1);

// Reader A edits the title and writes back under v1 -> accepted (master advances to v2).
a.copy.title = "Intro";
const wa = writeBack(server.heap, handle.id, a.version, a.copy);
check("reader A's write-back is accepted with no contention (-> v2)", wa.ok === true && wa.version === 2);
check("the master now carries A's change", master().title === "Intro" && server.heap.version(handle.id) === 2);

// Reader B still holds the stale v1 snapshot. It edits a DIFFERENT field and writes back
// under v1 -> REJECTED, because the master already moved to v2 under A.
b.copy.author = "Ada";
const wb = writeBack(server.heap, handle.id, b.version, b.copy);
check("reader B's stale write-back is rejected as a conflict", wb.ok === false && wb.version === 2);
check("the rejected write left the master untouched (A intact, no B)", master().title === "Intro" && master().author === null);

// B does the right thing: refetch (now v2, carrying A's title), re-apply its edit, retry.
const b2 = channel.fetch(handle);
check("B's refetch sees A's committed change", b2.version === 2 && b2.copy.title === "Intro");
b2.copy.author = "Ada";
const wb2 = writeBack(server.heap, handle.id, b2.version, b2.copy);
check("B's retry under the fresh version is accepted (-> v3)", wb2.ok === true && wb2.version === 3);
check("NO LOST UPDATE: the master carries both A's title and B's author",
  master().title === "Intro" && master().author === "Ada");

// --- B) the commitWrite helper: the optimistic loop resolves a real race by itself ------
// A competing writer lands BETWEEN this writer's fetch and its write-back on the first
// attempt. The helper must detect the conflict, refetch, and re-apply ON TOP of the
// competitor's change — never clobber it.
const counter = server.heap.put({ a: false, b: false });
let raced = false;
const result = commitWrite(channel, counter, (copy) => {
  copy.b = true;                                            // our intended edit
  if (!raced) {                                             // one-shot: a competitor writes first, between fetch and write-back
    raced = true;
    server.heap.mutate(counter.id, (o) => { o.a = true; }); // competitor bumps the master out from under us
  }
});
const counterMaster = server.heap.get(counter.id);
check("commitWrite eventually succeeds despite the race", result.ok === true);
check("it took exactly two tries (one conflict, one win)", result.tries === 2, `(tries=${result.tries})`);
check("both the competitor's and our change survived (no lost update)", counterMaster.a === true && counterMaster.b === true);

console.log(`\nWrite-back: the master is the sole serialization point; a lost race costs a refetch + retry (${channel.fetches} fetches total), never a silent lost update.`);
console.log(pass
  ? "PASS — §5 write-back coherence: optimistic CAS, conflicts detected and retried, no lost updates"
  : "FAIL");
process.exit(pass ? 0 : 1);
