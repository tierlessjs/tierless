// Probe: PER-FIELD/element delta granularity (the opt-in `session.fields` mode). The delta normally
// ships a changed container WHOLE — a one-field edit of a 60-field record crosses all 60 fields, a push
// crosses the array's whole ref-list. With fields-mode the codec ships a PATCH of only the slots that
// changed: an object's changed keys, an array's touched indices + length, a Map's set/deleted entries, a
// Set's added/removed members. It lives in the shared codec, so BOTH write-back (heap-write-delta) and
// the oscillation delta benefit. It is opt-in: with it off the wire is byte-for-byte unchanged (every
// other delta probe stays green), and the message-level min(delta, full) still backstops "never larger".
import { makeTrackedSession, adoptBaseline, encodeDeltaTracked, applyDeltaTracked, touch } from "stackmix/delta";
import { encodeGraph, decodeGraph } from "stackmix/graph";

const fresh = (v) => decodeGraph(JSON.parse(JSON.stringify(encodeGraph([v]))))[0];   // a structurally-identical detached copy
const frame = (m) => [{ fn: "_", pc: 0, m }];
const makeModel = () => ({
  profile: Object.fromEntries(Array.from({ length: 60 }, (_, i) => ["f" + i, i])),    // a 60-field record
  rows: Array.from({ length: 800 }, (_, i) => ({ id: i, v: i })),                      // a big array
  tags: new Set(Array.from({ length: 50 }, (_, i) => "t" + i)),                        // a Set
  index: new Map(Array.from({ length: 50 }, (_, i) => ["k" + i, i])),                  // a Map
});

let pass = true;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); pass = pass && cond; };
console.log("Probe: per-field/element delta granularity — ship the changed slots, not the whole container\n");

// fields ON (patch) vs OFF (whole container), the SAME single-slot mutation, to show the win per kind.
const measure = (mutate, container) => {
  const out = {};
  for (const fields of [true, false]) {
    const s = makeTrackedSession("s"); s.fields = fields;
    const m = makeModel(); adoptBaseline(s, frame(m), null);
    mutate(m); touch(s, container(m));
    out[fields ? "on" : "off"] = encodeDeltaTracked(s, frame(m), null).bytes.length;
  }
  return out;
};
const obj = measure((m) => { m.profile.f30 = 999; }, (m) => m.profile);
check(`object: one field of 60 ships a patch, not the record (${obj.on} B vs ${obj.off} B whole)`, obj.on * 8 < obj.off);
const arr = measure((m) => { m.rows.push({ id: 9999, v: 1 }); }, (m) => m.rows);
check(`array: a push ships a splice patch, not the 800-ref list (${arr.on} B vs ${arr.off} B whole)`, arr.on * 20 < arr.off);
const map = measure((m) => { m.index.set("k7", 777); }, (m) => m.index);
check(`Map: one entry ships a patch, not all 50 (${map.on} B vs ${map.off} B whole)`, map.on * 8 < map.off);
const set = measure((m) => { m.tags.add("new"); }, (m) => m.tags);
check(`Set: one add ships a patch, not all 50 (${set.on} B vs ${set.off} B whole)`, set.on * 8 < set.off);

// Correctness across an oscillation, including a BOUNCE (both tiers send, so both patch). A and B hold
// structurally-identical models on a shared baseline; each hop mutates one slot, ships a patch, applies.
const A = makeTrackedSession("server"); A.fields = true;
const B = makeTrackedSession("browser"); B.fields = true;
const mA = makeModel(), mB = fresh(mA);
adoptBaseline(A, frame(mA), null);
adoptBaseline(B, frame(mB), null);
const hop = (from, mFrom, to) => { applyDeltaTracked(to, encodeDeltaTracked(from, frame(mFrom), null).bytes); };

mA.profile.f1 = 11; touch(A, mA.profile);
mA.rows[400].v = 22; touch(A, mA.rows[400]);
mA.rows.push({ id: 800, v: 33 }); touch(A, mA.rows);
mA.index.set("k49", 44); touch(A, mA.index);
mA.index.delete("k0"); touch(A, mA.index);
mA.tags.add("hot"); mA.tags.delete("t0"); touch(A, mA.tags);
hop(A, mA, B);                                                          // server -> browser, all patches
check("object field patch applied", mB.profile.f1 === 11 && mB.profile.f59 === 59);
check("array element patch + push applied", mB.rows[400].v === 22 && mB.rows.length === 801 && mB.rows[800].v === 33);
check("Map set + delete patch applied", mB.index.get("k49") === 44 && !mB.index.has("k0") && mB.index.size === 49);
check("Set add + delete patch applied", mB.tags.has("hot") && !mB.tags.has("t0") && mB.tags.size === 50);
check("every untouched slot survived (no clobber)", mB.profile.f30 === 30 && mB.rows[399].v === 399 && mB.index.get("k25") === 25 && mB.tags.has("t25"));

// the BOUNCE: B edits and ships back; A applies. Both directions patch.
mB.profile.f2 = 222; touch(B, mB.profile);
mB.rows.pop(); touch(B, mB.rows);
hop(B, mB, A);                                                          // browser -> server
check("bounce: B's object patch reached A", mA.profile.f2 === 222);
check("bounce: B's array pop reached A (length back to 800)", mA.rows.length === 800);
check("bounce: A's earlier edits are intact after the round trip", mA.profile.f1 === 11 && mA.index.get("k49") === 44 && mA.tags.has("hot"));

console.log(pass
  ? "PASS — per-field/element granularity: object/array/Map/Set ship only the slots that changed, both directions of an oscillation, and it is opt-in (off = byte-identical)"
  : "FAIL");
process.exit(pass ? 0 : 1);
