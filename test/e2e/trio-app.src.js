// The trajectory fixture: a working set, then THREE sequential server data resources.
// Sized so that at EVERY hop fetch is locally cheaper than migrating (the greedy §6 rule
// fetches three times) — yet one migration at the first hop serves B and C inline on the
// server and beats the greedy total. The information that flips hop A ("two more server
// resources follow") exists only in a trace of a prior run; no per-hop comparison can
// recover it. Each fetched result also lands in the frame, so the continuation grows with
// every fetch — greedy digs itself deeper with each locally-correct choice.
//
//   node transform.cjs trio-app.src.js trio-app.gen.mjs --bare
function build(n) {
  let work = [];
  for (let i = 0; i < n; i = i + 1) { work[i] = "row-" + i; }   // pure: stays a plain local in Trio's frame
  return work;
}

function Trio(workSize, k) {
  const work = build(workSize);            // the live working set — sets the CONTINUATION (migrate) cost
  const a = api.fetchA(k);                 // three same-tier data resources in sequence:
  const b = api.fetchB(k);                 // the SUFFIX after fetchA is what greedy cannot see
  const c = api.fetchC(k);
  return { work: work.length, a: a.length, b: b.length, c: c.length };
}
