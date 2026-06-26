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

// --- nested function suspension: the continuation spans call boundaries ---
// fetchDouble/failingFetch are CALLEES that themselves suspend; their callers push a
// sub-frame, so the migrated continuation is a STACK of frames that travels as a unit.
function fetchDouble(id) {
  const row = api.get(id);            // suspends inside the callee
  return row + row;
}
function sumViaHelper() {
  let total = 0;
  for (let i = 1; i <= 3; i = i + 1) {
    const r = fetchDouble(i);         // CALL: push a sub-frame for fetchDouble, resume on return
    total = total + r;
  }
  return total;                       // (1+1)+(2+2)+(3+3) = 12
}
function failingFetch() {
  const v = api.fail(1);              // the resource fails in the callee
  return v;
}
function callerCatches() {
  let r = "start";
  try {
    const v = failingFetch();         // the callee's resource error...
    r = "ok:" + v;
  } catch (e) {
    r = "caught:" + e.message;        // ...is caught here, one frame up
  }
  return r;                           // "caught:resource failed"
}
function throwInMachine() {
  let out = api.get(1);               // a resource makes this function suspendable (compiled)
  try {
    out = "in";
    throw "boom";                     // a sync throw inside the state machine
  } catch (e) {
    out = "caught:" + e;
  }
  return out;                         // "caught:boom"
}

// --- suspensions in EXPRESSION positions (the compiler hoists them to temps) ---
function addPure(a, b) { return a + b; }   // pure helper: emitted verbatim, called inline
function returnExpr() {
  return api.get(7) + 1;              // resource value used in an expression -> hoisted
}
function assignRhs() {
  let out = "a";
  out = api.get(5);                   // resource on an assignment RHS -> hoisted
  return out;                         // 5
}
function ifTest() {
  if (api.get(1)) {                   // resource in an if-test -> hoisted before the if
    return "yes";
  }
  return "no";                        // "yes"
}
function whileTestSusp() {
  let i = 3;
  let sum = 0;
  while (api.dec(i)) {                // resource in a while-test -> desugared (re-evaluated each pass)
    sum = sum + i;
    i = i - 1;
  }
  return sum;                         // 3 + 2 + 1 = 6
}
function nestedArgs() {
  return addPure(api.get(2), api.get(3));  // two resources in a pure call's args -> hoisted in order
}
function callInExpr() {
  return fetchDouble(4) + 1;          // a suspendable call's result used in an expression -> hoisted
}

// --- suspensions in conditional / switch / labeled / do-while / loop-header positions ---
function ternaryPick() {
  let hi = 1;
  let x = hi ? api.get(7) : api.get(9);    // ?: — only the taken branch suspends (lowered to if/else)
  return x;                                // 7
}
function shortCircuit() {
  let off = 0;
  let a = off || api.get(5);               // || right side suspends
  let b = off && api.fail(1);              // && short-circuits: api.fail never runs
  return a + b;                            // 5 + 0 = 5
}
function switchPick() {
  let k = 2;
  let out = "none";
  switch (k) {
    case 1: out = api.get(10); break;
    case 2: out = api.get(20); break;
    default: out = api.get(0);
  }
  return out;                              // 20
}
function switchFall() {
  let k = 1;
  let acc = 0;
  switch (k) {
    case 1: acc = acc + api.get(1);        // falls through to case 2
    case 2: acc = acc + api.get(2); break;
    case 3: acc = acc + api.get(3);
  }
  return acc;                              // 1 + 2 = 3
}
function labeledBreak() {
  let found = 0;
  outer: for (let i = 1; i <= 3; i = i + 1) {
    for (let j = 1; j <= 3; j = j + 1) {
      const v = api.get(i * j);            // suspends in the inner loop
      if (v === 4) { found = v; break outer; }
    }
  }
  return found;                            // 4 (2*2)
}
function doWhileSusp() {
  let i = 0;
  let sum = 0;
  do {
    const v = api.get(i);                  // suspends in a do-while body
    sum = sum + v;
    i = i + 1;
  } while (i < 3);
  return sum;                              // 0 + 1 + 2 = 3
}
function forHeaderSusp() {
  let sum = 0;
  for (let i = api.get(1); i <= 3; i = i + 1) {  // suspending for-init -> hoisted before the loop
    sum = sum + i;
  }
  return sum;                              // 1 + 2 + 3 = 6
}
function returnInTry() {
  try {
    const v = api.get(5);
    return v;                              // early return out of a try/catch (pops the handler on the way out)
  } catch (e) {
    return -1;
  }
}
function breakOutOfTry() {
  let sum = 0;
  for (let i = 1; i <= 5; i = i + 1) {
    try {
      const v = api.get(i);
      if (v === 3) { break; }              // break crosses the try (pops its handler)
      sum = sum + v;
    } catch (e) {
      sum = -1;
    }
  }
  return sum;                              // 1 + 2 = 3
}
