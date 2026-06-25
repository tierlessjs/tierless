# Migration-enabled QuickJS (proof of concept)

This validates the load-bearing assumption behind delegating execution to QuickJS:
**a running QuickJS computation can be suspended — even in the middle of
synchronous code, at a DB or DOM reference — its state snapshotted, and resumed in
a different process / fresh instance.** If that holds, Stackmix can keep its
differentiated layer (continuation migration + the distributed handle heap + the
when-to-migrate policy) while getting a ~100%-conformant JS engine for free, and
retire the hand-rolled `src/wasm` compiler (which caps at ~60% Test262).

## What it proves

`demo.mjs` runs a **synchronous** JS function (no `async`, no `await`) that calls a
host `db_query(...)` mid-computation. At that call QuickJS suspends, its whole
linear memory is copied into a second, fresh instance that never ran the program,
that instance is handed the DB result, and it **resumes and finishes the original
computation**:

```
PASS  locals across the suspend: A suspended @ db_query, B resumed => 1092
PASS  deeper stack + heap object + closure used after resume: ... => 1092
PASS  loop state carried across the migrate: ... => 1036
```

`base`/`tax` (live C-stack locals), a heap object, a closure, and mid-loop
accumulator state all cross the instance boundary. No `await` in the user's code.

## How it works

QuickJS runs JS on the native C stack, so a synchronous suspension point is *not*
reachable by a plain heap snapshot — the live frames are on the C stack. We make
them migratable with **Asyncify** (Binaryen's stack-unwinding transform):

1. The JS calls `db_query(n)` → the C function `js_db_query` calls the async import
   `host_suspend` (`raw_lib.js`).
2. `host_suspend` calls `asyncify_start_unwind(buf)` and returns. Asyncify unwinds
   the entire QuickJS C call stack into `buf` — **a buffer in linear memory** — and
   `qjs_eval` returns to the host.
3. The host snapshots linear memory (which now contains the QuickJS heap *and* the
   unwound stack) and copies it into a fresh instance.
4. The destination sets the DB result, calls `asyncify_start_rewind(buf)` and
   re-enters `qjs_eval`. Asyncify replays the stack from `buf`; `host_suspend`
   returns the result; the synchronous computation continues to completion.

Because the unwound stack lives in linear memory, and the allocation is
deterministic across identical instances (the `dataPtr` matches), a plain
linear-memory copy is a complete migration. The asyncify functions are driven from
JS via `Module.wasmExports.asyncify_*` (the same exports emscripten's own runtime
uses) — no managed/event-loop coupling, so it works across instances.

## Files

| file | what |
| --- | --- |
| `qjs_migrate.c` | the shim: `qjs_init` / `qjs_eval` / `qjs_final` + the `db_query` host fn |
| `raw_lib.js` | the `host_suspend` async import that drives the asyncify unwind/rewind |
| `build.sh` | the emcc invocation (pinned: quickjs-ng 0.15.1, emscripten 3.1.74) |
| `qjsmig.wasm` / `qjsmig.mjs` | the prebuilt artifact (committed so `demo.mjs` runs without the toolchain) |
| `demo.mjs` | the cross-instance synchronous-migration demo |

## Rebuilding

Needs the emscripten toolchain (not in the default repo env):

```sh
# emsdk setup (one-time). Behind the agent proxy, emsdk's urllib downloader
# truncates large files — patch download_file() to always use download_with_curl().
git clone-equivalent (codeload tarball) emscripten-core/emsdk, then:
./emsdk install 3.1.74 && ./emsdk activate 3.1.74 && source ./emsdk_env.sh
./build.sh                 # fetches quickjs-ng 0.15.1 and builds qjsmig.{wasm,mjs}
node demo.mjs
```

## Caveats / not-yet

- Snapshots the full linear memory (here 32 MB, mostly unused). A real wire uses
  QuickJS's `JS_WriteObject` or a compaction pass — the live set is small.
- Resume-into-a-*fresh* instance is proven. Resume-into-an-*already-running*
  instance (heap merge) is harder and not covered here.
- Same-version only; cross-version QuickJS migration is fragile.
- `db_query` returns an int and the program returns an int — enough to prove the
  mechanism; a real shim would marshal richer values (QuickJS `JS_WriteObject`).
