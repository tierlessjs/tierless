# Native WASM path: finish, validate, and retire the interpreters

Status: in progress. This is the execution roadmap for making the AOT WASM compiler
(`src/wasm/aot.mjs`) the **only** execution engine and deleting both interpreters.
Each step lands as its own green commit (lint + typecheck + full `npm test`).

## Where we are

Three execution engines exist today:

1. `src/runtime/core.mjs` — the **JS bytecode interpreter**. Runs `createRuntime()`,
   i.e. every shipped example, the CLI, benches, wss. Also currently houses the
   interpreter-era migration codec (`serializeContinuation`/`deserializeContinuation`,
   `Tier`, `Suspend`/`Miss`, `initialFrames`).
2. `src/wasm/core.mjs` — an **older hand-written WASM bytecode interpreter**
   (interpreter.wat-style, numeric-subset opcodes). Runs `examples/wasm`,
   `wasm-two-process`, `policy`.
3. `src/wasm/aot.mjs` — the **AOT compiler** (IR → native WASM, full language surface).
   Currently **test-only**: nothing in `src/` (except its own wrapper/`heapwire`),
   `examples/`, `bench/`, `bin/` imports it. ~26 probes verify it against the
   interpreter as a differential oracle.

So "replace the interpreter with a compiler" is built-and-verified-in-isolation, but
**not integrated**. The product still runs on #1 / #2.

## End state

No interpreter. `aot.mjs` is the engine; the product compiles TS (and later other
languages) to WASM and runs it. The migration codec lives **in the compiled module**
(heap-layout-aware code belongs with the heap — same principle as regex/BigInt/JSON).
The host shrinks to transport + when-to-migrate policy + the `__fetch` deref-miss.

None of the five interpreter symbols survive: all are coupled to the interpreter's
JS frame representation. `serialize/deserialize` → in-WASM `__serialize`/`__deserialize`;
`Tier` → a thin host shell (instance + imports + id); `Suspend` → asyncify; `Miss` →
the `__fetch` import boundary; `initialFrames` → a direct `inst.exports[entry](...)` call.

## Migration-codec architecture (locked)

Worked out in design discussion; this is the target for the in-WASM codec.

- **Value model already solves pointer ID on the unwound stack.** Every value is
  low-bit-tagged (fixnum `n<<1`, pointer `addr|1`, handle `addr|3`, singletons odd and
  `< HEAP_BASE`). So a conservative tag scan finds all roots soundly; the only ambiguity
  is the untyped asyncify stack.

- **Size-segregated heap.** Two bump regions: SMALL (`< HANDLE_THRESHOLD`, 64 KB) and
  LARGE. Route allocations by byte size; **keep headers always SMALL, route backings by
  size**. A big array = small header (ships) + large backing (stays home as a §5 handle).
  Growth crosses cleanly: a backing that reallocs past the limit lands in LARGE and the
  (unmoved) header now points across the boundary — exactly the pointer that becomes a
  handle. This is "decide excise without walking": classification happens at allocation.
  (Old `wasm/core.mjs` already split `HEAP_SMALL_BASE`/`HEAP_BIG_BASE` — same lineage.)

- **Serialize = compact-into-the-wire.** A Cheney-style copy from roots: append each
  live small object to the wire buffer, rewrite its pointer fields to wire-relative
  offsets (or handles for large/cross-region refs), never visit garbage. The output IS
  the wire. One pass does drop-garbage + contiguous-layout + relativize + handle-substitute.
  Resident heap untouched (fast bump allocation during the run; compact only at the boundary).
  **Always compact — never ship garbage:** the wire is the scarce resource, local
  compaction is cheap, and its no-garbage floor is exactly the relocate+handle walk you
  owe anyway.

- **Relocation table for the stack only.** The heap is tag-typed → the destination
  relocates it by a tag-walk (`+base`), no table. The asyncify stack is untyped → ship a
  small fixup list of its pointer-slot offsets (built source-side from the source's own
  stack maps, validated against the live heap). Deserialize = `memcpy` → tag-walk heap
  `+base` → apply stack table `+base`. The destination needs **zero** layout/map
  knowledge — the wire is self-relocating (good for cross-version/cross-language).

- **Resident representation = absolute (style A).** Fast direct derefs. Relocation is
  folded into the compaction copy (out) and the rebuild walk (in) — both mandatory, so
  it's ~free. Keep position-independence (offset-from-base) in the pocket only for the
  thin-hoppy-small-heap case; resolve the residency-vs-arrival tradeoff with **adaptive
  absolutize** (promote hot/settled continuations, re-relativize lazily on the way out,
  which rides the mandatory excise walk).

Rejected: shipping zeroed+compressed garbage (still needs the walk to find dead, then
adds whole-region compress/decompress; slower than compaction, and its rewrite-avoidance
only pays under address-stability, which resume-into-existing denies). Sparse-extent
serialization noted as the better no-move option if ever wanted.

Open decision deferred until it bites: precise stack maps vs conservative scan for
building the stack fixup table at serialize. Conservative-scan-plus-target-validation is
sound enough for v1; precise maps are the upgrade if false positives ever matter.

## Execution sequence (each = a green commit)

1. **Deep heap-decoder + true parity run.** `readDeep(memory, v, keystr)` in `aot.mjs`
   that fully materializes the native heap (arrays, objects via `__keystr`, Map/Set,
   nesting) to JS values; a `decode` compile flag that exports `__keystr`. Run the real
   `realts`/`conformance`/`difftest` corpora through `aot.mjs` vs Node → the true parity
   number and the complete gap list. This walk is the host-side prototype of `__serialize`.
2. **Close the gaps** the parity run surfaces. Started at **38 pass / 2 mismatch /
   10 error / 8 skipped** over the 58-case sync `realts` corpus. Closed, each its own
   green commit:
   - `**` on numbers → host `Math.pow`, boxed.
   - string/float/etc. literals in a generator body → shared `pushLit` (was codegen drift).
   - `this`/env capture in a generator body → env carried in the generator object.
   - array ops (NEWARR/ARRPUSH/ARRGET/ARRLEN/APPENDALL/TOARRAY) in a generator body.
   - computed access fires accessors → `__index`/`__setindex` are accessor-aware (also
     the detection: an accessor *definition* now triggers `usesAccessors`).
   - `Object.values`; `Object.assign`.
   - arrow functions capture lexical `this` (closure capture kind "T").
   - for-of over a string → an ITERTAG iterator that yields one-char strings.
   - the callable globals: `Number`/`String`/`Boolean`/`parseInt`/`parseFloat`/`isNaN`/`isFinite`.
   - generator `.return()` runs `finally` on abandon → a `RETSIG` sentinel raised at the
     resume point unwinds through the body's catch/finally machinery; `__genret` resolves it.
   - per-**object** key hiddenness (a `HIDDEN_FLAG` bit on the stored key id), replacing the
     per-*keyId* global flag — so a name can be a hidden method on one object and an
     enumerable data key on another (also closed the `#private`-fields snippet).
   - `String.raw` → compile-time raw concatenation in the frontend (was a native OOB fault).
   - polymorphic operators (`+`/`===`/`/`/bitwise/`**`…) inside a generator body → the
     gen-body codegen was integer-only; hoisted the operator logic into one module-level
     `binExpr` shared by both the straight-line and generator-body codegens (was codegen drift).

   **Now at 58 pass / 0 fail / 0 error / 0 skipped** — the whole sync corpus matches Node.
   (The measurement harness inlines each entry's args as literals, so it also runs the
   object/array-arg cases the earlier integer-only marshaler had to skip.) Every known
   correctness gap is closed; the next step is to *prove* conformance with a standard
   suite (Test262) rather than chase ad-hoc snippets. Async snippets (`checkAsync`) are
   validated separately by the `wasm-async` probe against the interpreter oracle.
3. **In-module reachability walk + relocatable encode/decode** for a settled (non-suspended)
   heap value. Prove `__serialize` → fresh instance → `__deserialize` round-trips against
   the deep-decoder.
4. **Size-segregated heap + §5 handle threshold** in the allocator and the walk.
5. **Asyncify stack capture + stack relocation table** (the suspended case). Switch the
   migration probes (`wasm-aot`, `asyncify`, `wasm-aot-wss`, `wasm-fetch`) onto the
   in-module codec; delete `heapwire`'s host-side heap walk.
6. **Integrate + retire.** Wire `aot.mjs` into a native runtime path; port `examples/wasm`,
   `wasm-two-process`, `policy` (then ideally CLI). Delete `src/wasm/core.mjs` outright.
   Reduce `src/runtime/core.mjs` to nothing the native path needs (its codec is dead);
   delete the interpreter loop and the five symbols. Switch the corpora harnesses to
   native-vs-Node. Keep the interpreter only as long as it's still the oracle during 1–5.

## Validation discipline

Until step 6, the JS interpreter stays as the differential oracle. After the deep-decoder
(step 1) the oracle for pure results can shift to Node `eval` directly; migration
correctness is checked by the in-tier invariant *migrated-native == straight-through-native*.
Every commit: `npm run lint` (0 errors), `npm run typecheck`, `npm test` ("all green").
