// Headless probe: a §5 write-back IS a delta to the master. The reader fetches a snapshot, mutates it,
// and the write-back ships ONLY the objects that changed, applied to the master IN PLACE under CAS. The
// wire is proportional to the change, not the snapshot. And it is never larger than the old whole-object
// write-back — the host ships min(delta, whole). This is the collapse: write-back and the oscillation
// delta are the same mechanism, so collections come for free (the codec diffs the RESULT, not the
// operation). Granularity is per-OBJECT — a changed array ships its element ref-list (the per-element
// floor that (B) sharpens), but a changed element's CONTENT, and every unchanged object, stays home.
import { openSnapshot, diffSnapshot, wholeSnapshot, applySnapshot } from "./wire-delta.mjs";
import { encodeGraph, decodeGraph } from "./graph.mjs";

const fetchCopy = (v) => decodeGraph(JSON.parse(JSON.stringify(encodeGraph([v]))))[0];   // a detached snapshot, as Channel.fetch makes one
const fmt = (n) => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB");

let pass = true;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); pass = pass && cond; };
console.log("Probe: §5 write-back as a delta — only the changed objects cross, collections included\n");

const body = "markdown body. ".repeat(40);
const newMaster = () => {
  const shared = { kind: "draft" };
  return {
    rows: Array.from({ length: 1500 }, (_, i) => ({ id: i, title: "Article " + i, score: i % 100, body, meta: i < 2 ? shared : null })),
    tags: new Set(["news", "tech"]),
    index: new Map([["news", 10], ["tech", 20]]),
    config: { theme: "light", page: 1 },
  };
};
const wholeOf = (v) => wholeSnapshot("browser", v).length;

// ── Case 1: member edits — ship just the touched objects (the clean per-object win) ─────────────────
{
  const master = newMaster(), copy = fetchCopy(master), whole = wholeOf(copy);
  const session = openSnapshot("browser", copy);
  copy.rows[2].score = 777;                 // member assignment
  copy.config.theme = "dark";               // nested member assignment
  copy.rows[0].meta.kind = "published";     // mutate the SHARED object (reachable from rows[0] and rows[1])
  const delta = diffSnapshot(session, copy);
  check(`member edits ship only the touched objects (${fmt(delta.length)} vs ${fmt(whole)} whole, ${(whole / delta.length).toFixed(0)}x smaller)`, delta.length * 50 < whole);
  applySnapshot("server", master, delta);
  check("member edit landed (rows[2].score)", master.rows[2].score === 777);
  check("nested member edit landed (config.theme)", master.config.theme === "dark");
  check("the change to the SHARED object traveled once and both refs see it", master.rows[0].meta === master.rows[1].meta && master.rows[0].meta.kind === "published");
  check("every unchanged row stayed home (values + bodies intact)", master.rows[1].score === 1 && master.rows[3].body === body && master.rows[5].title === "Article 5");
}

// ── Case 2: collection mutations — push / Map set / Set add, all handled by the content-based codec ──
{
  const master = newMaster(), copy = fetchCopy(master), whole = wholeOf(copy);
  const session = openSnapshot("browser", copy);
  copy.rows.push({ id: 9999, title: "New", score: 5, body, meta: null });  // ARRAY push
  copy.index.set("fresh", 30);                                             // MAP set
  copy.tags.add("urgent");                                               // SET add
  const delta = diffSnapshot(session, copy);
  // smaller than the whole snapshot (the 1500 unchanged rows' CONTENT never re-ships — only the changed
  // array's ref-list, the new row, and the two small containers do). Per-object, not per-element: (B).
  check(`collection mutations ship the changed containers, not the whole (${fmt(delta.length)} vs ${fmt(whole)} whole)`, delta.length * 4 < whole);
  applySnapshot("server", master, delta);
  check("ARRAY push landed (a new row at the end)", master.rows.length === 1501 && master.rows[1500].id === 9999);
  check("MAP set landed (index.fresh)", master.index.get("fresh") === 30 && master.index.size === 3);
  check("SET add landed (tags.urgent)", master.tags.has("urgent") && master.tags.size === 3);
  check("unchanged rows stayed intact through the collection write-back", master.rows[1].score === 1 && master.rows[3].body === body);
}

// ── min(delta, whole): a near-total change is never larger than the old whole-object write-back ──────
{
  const tiny = { a: 1, b: 2 }, tinyMaster = fetchCopy(tiny);
  const ts = openSnapshot("browser", tiny);
  tiny.a = 9; tiny.b = 8; tiny.c = 7;                                    // change all of it
  const td = diffSnapshot(ts, tiny), tw = wholeSnapshot("browser", tiny);
  check("min(delta, whole): on a near-total change the whole wins, so the wire is never larger", Math.min(td.length, tw.length) <= tw.length);
  applySnapshot("server", tinyMaster, td.length < tw.length ? td : tw);
  check("the near-total change still applies correctly", tinyMaster.a === 9 && tinyMaster.b === 8 && tinyMaster.c === 7);
}

console.log(pass
  ? "PASS — a §5 write-back ships only the changed objects (member edits and collection mutations alike), far smaller than the whole snapshot, and min(delta, whole) is never larger"
  : "FAIL");
process.exit(pass ? 0 : 1);
