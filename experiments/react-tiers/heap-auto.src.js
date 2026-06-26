// Same as heap-app, but the developer writes ORDINARY code — no deref() call. Compiled
// with --auto-deref, the compiler guards every read of a data-resource local (`rows`)
// with `if (isHandle(rows)) rows = deref(rows)`, so touching it on the browser (where it
// arrived as a §5 handle) fetches it transparently. On the server the guards are no-ops.
//
//   node transform.cjs heap-auto.src.js heap-auto.gen.mjs --bare --auto-deref
function digest(rows) {
  let total = 0;
  for (let i = 0; i < rows.length; i = i + 1) { total = total + rows[i].score; }
  return total;
}

function Report() {
  const rows = api.getRows();                              // big dataset, lives on the server
  const total = digest(rows);                              // server-side read (guard is a no-op there)
  const ev = commit({ total: total, count: rows.length }); // browser commits a small summary; `rows` stays home
  if (ev.want != null) {
    return rows[ev.want].title;                            // browser reads `rows` -> auto-deref -> fetch over the wire
  }
  return "no detail";
}
