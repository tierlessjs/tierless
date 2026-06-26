// §6 migrate-vs-fetch, LIVE. The browser builds a working set, then needs a server data
// resource to finish. Depending on the RELATIVE sizes the driver either ships this whole
// continuation to the server (migrate — the working set travels with the computation) or
// pulls the data back over the socket and finishes here (fetch — only the result travels).
// Both options are priced with real measured bytes; the cheaper one wins (§6).
//
//   node transform.cjs policy-app.src.js policy-app.gen.mjs --bare
function build(n) {
  let work = [];
  for (let i = 0; i < n; i = i + 1) { work[i] = "row-" + i; }   // pure: no resource -> stays a plain local in Survey's frame
  return work;
}

function Survey(workSize, dataKey) {
  const work = build(workSize);            // the live working set — its size sets the CONTINUATION (migrate) cost
  const data = api.fetchData(dataKey);     // §6 boundary: a server data resource — its size sets the FETCH cost
  return { work: work.length, data: data.length };
}
