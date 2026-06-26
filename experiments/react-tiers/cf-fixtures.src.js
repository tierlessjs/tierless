// Functions exercising the compiler's EXTENDED control flow (loops/continue/try). Each
// is written as plain single-place code; transform.cjs lowers them to serializable state
// machines. api.* are tier-pinned (server) resources; the control-flow.mjs probe mocks
// them (api.dbl/api.get return their first arg, api.fail throws) and serializes the
// continuation at every suspend to prove loop state and the try-handler stack migrate.
//
// Regenerate:  node transform.cjs cf-fixtures.src.js cf-fixtures.gen.mjs --bare
function forContinue() {
  let sum = 0;
  for (let i = 1; i <= 6; i = i + 1) {
    if (i % 2 === 0) continue;        // skip evens
    const x = api.dbl(i);             // suspend inside the loop
    sum = sum + x;
  }
  return sum;                         // 1 + 3 + 5 = 9
}
function whileBreak() {
  let n = 0;
  let acc = 0;
  while (n < 100) {
    n = n + 1;
    const v = api.get(n);             // suspend inside the loop
    acc = acc + v;
    if (acc >= 10) break;
  }
  return acc;                         // 1 + 2 + 3 + 4 = 10, then break
}
function catchAcrossTier() {
  let r = "start";
  try {
    const v = api.fail(1);            // the resource throws ON ITS TIER, across the suspend
    r = "got:" + v;
  } catch (e) {
    r = "rescued:" + e.message;       // ...and is caught here
  }
  return r;                           // "rescued:resource failed"
}
function finallyRuns() {
  let log = "";
  try {
    log = log + "a";
    const v = api.get(5);             // suspend inside try
    log = log + v;
  } finally {
    log = log + "F";                  // runs on the normal path
  }
  return log;                         // "a5F"
}
function catchFinally() {
  let log = "";
  try {
    log = log + "a";
    const v = api.fail(1);            // throws across the suspend
    log = log + v;
  } catch (e) {
    log = log + "C";                  // catch runs
  } finally {
    log = log + "F";                  // then finally runs
  }
  return log;                         // "aCF"
}
