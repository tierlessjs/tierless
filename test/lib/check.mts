// Shared PASS/FAIL check helpers for test/probes and test/e2e proofs. Two shapes exist in the
// wild and both are kept (not force-unified) because they report differently: makeCheck() tracks
// a single pass/fail boolean for the whole run (the final message is typically "PASS — <claim>" or
// "FAIL"), makeCounter() tracks separate pass/fail counts (the final message reports a count, e.g.
// "OK — <claim> (${pass} checks)" or "(${pass} passed, ${fail} failed)").
export function makeCheck() {
  let pass = true;
  const check = (name: string, cond: boolean, extra: unknown = ""): void => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
    pass = pass && cond;
  };
  return { check, ok: () => pass };
}

export function makeCounter() {
  let pass = 0, fail = 0;
  const check = (label: string, cond: boolean, got?: unknown): void => {
    if (cond) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${got === undefined ? "" : `  (got ${JSON.stringify(got)})`}`); }
  };
  return { check, counts: () => ({ pass, fail }) };
}
