// A continuation that holds a BIG server dataset, commits a SMALL summary to the browser,
// and fetches the dataset back only if the browser asks for a row's detail.
//
//   - api.getRows()  : server resource -> a big array (the heap)
//   - digest(rows)   : pure, runs server-side (touches the big data where it lives)
//   - commit(summary): browser resource -> the small projection crosses; `rows` stays home
//   - deref(rows)    : on the browser, materialize the server-owned handle (fetch over the wire)
//
// Compiled with:  node transform.cjs heap-app.src.js heap-app.gen.mjs --bare
function digest(rows) {
  let total = 0;
  for (let i = 0; i < rows.length; i = i + 1) { total = total + rows[i].score; }
  return total;
}

function Report() {
  const rows = api.getRows();                              // big dataset, lives on the server
  const total = digest(rows);                              // server-side: touches the big data
  const ev = commit({ total: total, count: rows.length }); // browser commits a small summary; `rows` does not travel
  if (ev.want != null) {
    const page = deref(rows);                              // the browser needs a row now -> fetch the dataset from the server
    return page[ev.want].title;
  }
  return "no detail";
}
