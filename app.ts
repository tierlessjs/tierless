// The Stackmix application — ordinary TypeScript. No tier annotations: the runtime
// infers placement from which resources you touch (§3, principle #1). Touching
// db.query forces the server; touching DOM.renderList forces the client. The
// loop runs wherever it already is (lazy placement), so it filters on the
// server where the data lives, and only the small `matched` result migrates to
// the client to be rendered.

// Resources are imports — the tier model. (Declared here so the file reads as
// real TypeScript; the frontend lowers these calls to RES instructions.)
declare const db: { query(): number[] };
declare const DOM: { renderList(items: number[]): number };

// The resource boundary (DOM.renderList) fires INSIDE this nested call, so when
// execution migrates the continuation must carry BOTH frames (render -> show) —
// proving multi-frame capture (§4.4 "enough call-stack frame info to resume").
function show(items: number[]): number {
  return DOM.renderList(items);        // client resource, one frame deep
}

function render(threshold: number): number {
  const rows = db.query();              // server resource: a large array
  const matched: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    if (v >= threshold) {
      matched.push(v);                  // keep only the matches (small)
    }
  }
  return show(matched);                 // boundary fires inside show()
}
