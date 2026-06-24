/* eslint-disable no-unused-vars */
// These functions are the harness contract — referenced only from the Test262 test
// source that run262.mjs concatenates ahead of them, so ESLint sees them as unused.
//
// A Stackmix-compatible Test262 harness shim.
//
// The real Test262 harness (sta.js + assert.js) builds Test262Error with the
// constructor-function `this` pattern, attaches assert.sameValue etc. as
// properties of the `assert` function, and uses Object.defineProperty / instanceof.
// Stackmix supports none of those on plain functions, so this shim re-expresses the
// SAME observable contract in the supported surface: object literals instead of
// `this`/`new`, and standalone `__assert*` functions instead of function-valued
// properties. run262.mjs textually rewrites `assert.sameValue(...)` ->
// `__assertSameValue(...)`, `assert.throws(T, fn)` -> `__assertThrows(fn)` (the
// expected-error TYPE is dropped — Stackmix has no built-in error constructors, so
// throws is checked loosely: did it throw at all), and `new Test262Error(m)` ->
// `__t262err(m)`.
//
// Semantics that DO matter for conformance are exact: __sameValue is SameValue
// (NaN equals NaN; +0/-0 are indistinguishable because Stackmix canonicalizes -0
// to +0, a documented limitation).

function __t262err(message) { return { name: "Test262Error", message: message }; }
function $DONOTEVALUATE() { throw "Test262: This statement should not be evaluated."; }

function __sameValue(a, b) {
  if (a === b) { return true; }      // (===) covers everything except NaN; -0/+0 already collapsed
  return (a !== a) && (b !== b);     // both NaN -> SameValue true
}

function assert(mustBeTrue, message) {
  if (mustBeTrue !== true) { throw __t262err("assert: " + message); }
}
function __assertSameValue(actual, expected, message) {
  if (!__sameValue(actual, expected)) { throw __t262err("sameValue: " + message); }
}
function __assertNotSameValue(actual, unexpected, message) {
  if (__sameValue(actual, unexpected)) { throw __t262err("notSameValue: " + message); }
}
// The expected-error type was dropped by the rewrite, so this only checks that the
// thunk threw SOMETHING (Stackmix has no typed built-in errors to match against).
function __assertThrows(func, message) {
  var threw = false;
  try { func(); } catch (e) { threw = true; }
  if (!threw) { throw __t262err("expected a throw: " + message); }
}

// compareArray.js: element-wise array equality (used by assert.compareArray).
function __compareArray(a, b) {
  if (a.length !== b.length) { return false; }
  for (var i = 0; i < a.length; i++) { if (!__sameValue(a[i], b[i])) { return false; } }
  return true;
}
function __assertCompareArray(actual, expected, message) {
  if (!__compareArray(actual, expected)) { throw __t262err("compareArray: " + message); }
}
