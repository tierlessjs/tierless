# Working notes — for #4 (the frontend transform). TEMP / scratch.

Context dump so it's fresh when we get to #4. Not polished.

## Lineage
The design's Rhino/"Aesop" PoC (design doc §1) traces to a 2006 thread with
Neil Mix (author of **NJS / Narrative JavaScript**). NJS = a CPS source-to-source
compiler that reified the JS stack into a continuation *object* via a blocking
operator, running on stock engines (incl. Rhino). The 2006 design already had,
by name: migrate-vs-fetch, lazy placement ("opportunistic context oscillation"),
resource-pinning (DOM/native = can't move → transfer the stack), and usage-based
prefetch. i.e. the model has been stable for ~20 years; that's reassuring.

## #4 approach (frontend: getting real TS into capturable form)
- Go the **NJS route: a CPS / state-machine source transform over a TS subset**
  (TS compiler API / SWC / Babel), NOT a full interpreter. More deployable for
  real TS than the interpreter we used for the toy subset.
- Emit **our own serializable continuation** at boundary points. The transform
  owns the reification; the runtime (this repo) owns capture/serialize/migrate.

## The one thing that changed in 20 years (and the trap)
- `async/await` + generators are now **native suspension**. Use them as the
  *boundary shape*: a resource access is just an `await`. NJS had to invent the
  blocking operator; we don't.
- TRAP: native async is **suspend-but-not-serialize**. A suspended async/gen
  state is engine-internal — you can't capture it as bytes and ship it. This is
  exactly §8's line about the stack-switching proposal being in-process/one-shot.
  So: reuse async semantics for the boundary + local suspend, but the
  transportable continuation is still ours to build (CPS-to-data), same as NJS.

## Don't forget
- **Source maps**: NJS captured the stack but deferred line/file metadata. Our
  §10.6. Design it into the transform from the start, don't bolt on.
- **Heap deref shape** (from the email; informs #2 now): a deref consults an
  invalidating cache and resolves three ways —
  `local? use master : movable-data? fetch (+cache) : pinned-resource? migrate`.
