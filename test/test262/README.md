# Test262 conformance for the native (AOT WASM) path

This runs [Test262](https://github.com/tc39/test262) — the official ECMAScript
conformance suite — against the Stackmix AOT compiler (`src/wasm/aot.mjs`), to
prove correctness with a recognized standard rather than ad-hoc snippets.

## Run it

```sh
node test/test262/fetch262.mjs                 # one-time: fetch the pinned snapshot (~9.5 MB) into vendor/ (gitignored)
node test/test262/run262.mjs                   # default: language/expressions
node test/test262/run262.mjs language/statements/if --list-fails
```

It is **not** part of `npm test` (it needs the network-fetched corpus); it's an
opt-in tool for measuring conformance and finding bugs.

## How it works

A Test262 test is top-level script code that runs to completion when it conforms
and throws a `Test262Error` (via the `assert.*` harness) when it doesn't. The
runner compiles `shim + test body` to native WASM, runs it, and reads `EXC_FLAG`
out of linear memory to see whether it threw. Outcomes:

| bucket | meaning |
| --- | --- |
| **PASS** | compiled, ran, matched the expectation |
| **FAIL** | compiled and ran, but the **wrong** result — a real conformance bug |
| **TRAP** | compiled, but the native code trapped at runtime (a bug or a gap) |
| **UNSUPPORTED** | the frontend/aot can't compile it — a coverage gap, not a bug |
| **SKIP** | out of scope: `module`/`async`/`raw` flags, or an unprovided harness include |

The headline is `PASS / (PASS + FAIL + TRAP)` — conformance over the supported
surface. **FAIL** and **TRAP** are the actionable buckets.

## The harness shim and its loosenings

Stackmix supports a subset of JS, so the standard harness (`sta.js`/`assert.js`)
can't run verbatim — it uses the constructor-`this` pattern, attaches methods to
the `assert` function object, and uses `Object.defineProperty`/`instanceof`, none
of which Stackmix supports on plain functions. `harness262.js` re-expresses the
same contract in the supported surface, and `run262.mjs` rewrites the call sites
(`assert.sameValue` → `__assertSameValue`, etc.). Two deliberate loosenings:

- **`assert.throws(T, fn)` ignores the error type `T`.** Stackmix has no built-in
  error constructors (`TypeError`…) to match against, so we only check that `fn`
  threw *something*.
- **`negative` tests don't check the error type** either — only that the failure
  happened at the right phase (compile-time vs runtime).

So this measures **value/behavior** conformance, not the exact-error-type details.

## Why so much is UNSUPPORTED

Test262 exercises the whole language; Stackmix targets a subset. Common reasons a
test lands in UNSUPPORTED/SKIP: `eval` (much of the old Sputnik corpus), `Symbol`,
`BigInt` mixing, `Proxy`/`Reflect`/typed arrays, getters/setters and property
descriptors, `this` in plain (non-class) functions, and `class` features. These
are coverage gaps, not wrong answers.

## Bugs this has already found and fixed

- **`NaN === NaN` returned `true`** (the identical-bits fast path fired before the
  float-by-value compare). Fixed: strict equality compares boxed floats by value.

## Snapshot

Pinned to test262 `de8e621` (main, 2026-06). Over the curated core operator /
statement chapters (the most representative of the supported surface):

```
PASS 427   FAIL 206   TRAP 149   UNSUPPORTED 305   SKIP 24
conformance (PASS / runnable) = 427 / 782 = 54.6%
```

UNSUPPORTED dominates because Test262 covers the whole language (see above). FAIL
and TRAP are the triage queue toward retiring the interpreter — the native path
must match the interpreter oracle on everything in scope.
