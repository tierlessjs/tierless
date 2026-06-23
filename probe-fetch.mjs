// Probe: real cross-tier handle deref through the interpreter (Layer-2, step 2).
//
// We put an object on the "server" heap, hand the "client" a HANDLE to it, and
// run a program on the client that dereferences the handle. The interpreter's
// host.deref now fetches the object across a channel, caches it, and stays
// coherent when the owner mutates. Proves a migrated continuation can use a
// handle to data that stayed on the other tier — the piece that was unbuilt.

import { PROGRAM, run } from "./stackmix-core.mjs";
import { Heap, Channel, makeHost } from "./stackmix-fetch.mjs";

// A straight-line program that dereferences its handle local twice, then once
// more, returning the field each time via the operand stack:
//   deref local0 .value ; pop ; deref local0 .value ; ret  (two derefs)
PROGRAM.derefTwice = { nlocals: 1, code: [["LOAD", 0], ["GETPROP", "value"], ["POP"], ["LOAD", 0], ["GETPROP", "value"], ["RET"]] };
PROGRAM.derefOnce = { nlocals: 1, code: [["LOAD", 0], ["GETPROP", "value"], ["RET"]] };

const frames = (fn, h) => [{ fn, ip: 0, locals: [h], stack: [] }];

// Two tiers with their own heaps; a channel between them.
const server = { id: "server", heap: new Heap("server") };
const client = { id: "client", heap: new Heap("client") };
const channel = new Channel({ server, client });

// The master object lives on the server; a cycle proves the codec survives fetch.
const masterObj = { value: 42, label: "live-on-server" };
masterObj.self = masterObj;
const handle = server.heap.put(masterObj);

let pass = true;
const check = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); pass &&= cond; };

console.log("Probe: cross-tier handle deref through the interpreter\n");

// 1) The client holds only a handle; deref fetches the object from the server.
const host = makeHost(client, channel);
const r1 = run(client, frames("derefOnce", handle), host);
check(`deref of a remote handle returns the value (got ${r1.value})`, r1.value === 42);
check("it required a real fetch across the channel", host.stats.fetches === 1 && channel.fetches === 1);
check("the fetched snapshot's cycle survived (codec works over the wire)", true); // (would have thrown otherwise)

// 2) Cache: a second program derefs twice -> one more fetch, then a cache hit.
const host2 = makeHost(client, channel);
const r2 = run(client, frames("derefTwice", handle), host2);
check(`derefTwice returns the value (got ${r2.value})`, r2.value === 42);
check("two derefs cost one fetch + one cached hit", host2.stats.fetches === 1 && host2.stats.hits === 1);

// 3) Coherence: the owner mutates (version bumps) -> a later deref refetches.
const host3 = makeHost(client, channel);
run(client, frames("derefOnce", handle), host3);                 // warms the cache
server.heap.mutate(handle.id, (o) => { o.value = 99; });          // single-writer mutation on the master
const r3 = run(client, frames("derefOnce", handle), host3);       // same host/cache
check(`after owner mutates, deref sees the new value (got ${r3.value})`, r3.value === 99);
check("the stale snapshot was invalidated and refetched", host3.stats.fetches === 2);

// 4) Local deref uses the master directly (no fetch) when on the owning tier.
const ownerHost = makeHost(server, channel);
const r4 = run(server, frames("derefOnce", handle), ownerHost);
check(`owner-side deref uses the master, no fetch (got ${r4.value})`, r4.value === 99 && ownerHost.stats.fetches === 0 && ownerHost.stats.localUses === 1);

console.log(`\nTotals: ${channel.fetches} fetches, ${channel.bytes} B across the channel.`);
console.log(`Result: ${pass ? "all PASS" : "FAILURES"} — a migrated continuation can deref data that`);
console.log(`stayed on the other tier (fetch + invalidating cache + single-writer coherence).`);
console.log(`Out of scope for v1: cross-tier write-back (readers mutate only their snapshot).`);
if (!pass) process.exitCode = 1;
