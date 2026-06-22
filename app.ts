// The Waso application — ordinary TypeScript. No tier annotations: the runtime
// infers placement from which resources you touch (§3, principle #1). Touching
// db.query forces the server; touching DOM.renderList forces the client. The
// loop runs wherever it already is (lazy placement), so it filters on the
// server where the data lives, and only the small `matched` result migrates to
// the client to be rendered.

// Resources are imports — the tier model. (Declared here so the file reads as
// real TypeScript; the frontend lowers these calls to RES instructions.)
declare const db: { query(): number[] };
declare const DOM: { renderList(items: number[]): number };

function render(threshold: number): number {
  const rows = db.query();              // server resource: a large array
  const matched: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    if (v >= threshold) {
      matched.push(v);                  // keep only the matches (small)
    }
  }
  DOM.renderList(matched);              // client resource
  return matched.length;
}
