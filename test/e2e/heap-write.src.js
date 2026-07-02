// Transparent WRITE-BACK: the developer writes ordinary mutating code — `rows[i].score = v`
// — with no deref() and no writeBack() call. Compiled with --auto-deref --auto-writeback, the
// compiler (1) guards each READ of the data-resource local `rows` so touching it on the tier
// where it arrived as a §5 handle fetches it, and (2) emits a write-back after each member
// MUTATION through `rows`, propagating the edit to the server master under optimistic CAS. On
// the owning tier both are no-ops/local. The symmetric partner of heap-auto (reads).
//
//   node transform.cjs heap-write.src.js heap-write.gen.mjs --bare --auto-deref --auto-writeback
function Edit() {
  const rows = api.getRows();                  // big dataset, lives on the server
  const ev = commit({ count: rows.length });   // migrate to the browser; `rows` stays home as a handle
  rows[ev.idx].score = ev.score;               // browser edits a row -> auto-deref fetches, auto-writeback propagates back
  return rows[ev.idx].score;                   // read the edited value back (now materialized locally)
}
