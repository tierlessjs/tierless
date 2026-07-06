# Compiling Vikunja's real code — coverage checklist

Direction (supersedes the shadow-workflow port): the app's own service layer becomes
the migrating continuation. No parallel statement of intent, no XHR interception —
the I/O bottom moves to tierless resources (patch 0005, the axios adapter) and the
compiler carries their actual code. `node ports/vikunja/compile-coverage.mts` runs
their real files through the transform; this file tracks what it finds.

## Findings (2026-07-06)

1. ~~Class methods are not compilation units~~ **DONE.** Methods of top-level named
   classes with tier calls compile into PROGRAMS (`Cls$method`, receiver as frame
   arg 0, `this` rewritten arrow-aware); the kept class's method becomes a stub that
   routes through `__bindTierlessMethods` and falls back to the untouched original —
   unbound bundles behave stock. Per-method graceful: blockers are reported in
   meta.methods, never a whole-file failure. `await` of a tier call is absorbed into
   the suspension. Result on their real code: **AbstractService compiles 6/6 of its
   http-bearing methods** (getM, getAll, create, post, delete, uploadFormData) —
   and every service subclass inherits the stubbed base, so this one class covers
   the whole service layer. ProjectService.removeBackground also compiles.

2. **`this.http.get(...)` recognition DONE** (config `resources: {"this.http":
   "server"}`; the receiver is dropped from the request — the namespace binds per
   tier via exec). Still open from the original item: the server-side exec for the
   `http.*` namespace — the twin instance built by THEIR `HTTPFactory()` with the
   adapter at the bottom, plus leases for `window.API_URL`/`getToken()`.

3. **The UI layer correctly stays put.** `useTaskList` (ref/computed/watch) is kept
   verbatim as a pure export — right outcome: the migration boundary is the service
   method call, reactivity stays in the browser.

## Open items (in order)

- **Runtime wiring**: `__bindTierlessMethods` → the page's shared host; `http.*`
  server exec = twin axios instance from their factory over restResources(localhost);
  leases for the two pinned globals. Then a compiled `getAll` can actually migrate.
- **Method-to-method suspendability**: an uncompiled method calling `this.getAll()`
  hits the stub and works (host-routed), but is itself not migratable; propagate
  suspendability through `this.*` call edges the way module fns already do.
- **`super` in compiled methods** (TaskCollectionService.getReplacedRoute) — carry
  super dispatch in the frame, or inline the parent method.
- **Non-resource `await` inside otherwise-compilable methods** — local-await
  suspension kind (park, await natively, resume in place; a barrier for migration
  but not for compilation).

## Status

- Patch 0005 (axios adapter at the I/O bottom) CERTIFIED behaviorally invisible:
  full suite 196/199, identical failure set to stock (the two drag flakes upstream
  retries for + Dex), zero session-socket traffic, same wall time (8.5 min).
- Patch 0006 (compile AbstractService): **project suite 59/59 in stock wall time
  (2.1 min)** — their real compiled getAll/create/post/delete running reads AND
  writes over the session's fetch arm. Three boundary defects found and fixed by
  their suite on the way (each in tierless, never worked around): the service's
  own request-interceptor chain now runs browser-side with the post-chain config
  crossing (= what axios hands its adapter); the wire body is literally axios's
  JSON pass (toJSON/Dates); exec errors carry error.response whole. Eleven more
  network-wait accommodations joined 0004 (writes cross the session now too).
- Patches 0001/0002 (route workflow + shim) removed from the recipe: superseded.
  The measured shadow-port results live in git history and the README's record.

## First compiled-native measurement (2026-07-06, results/native-*.jsonl)

196/196 pass parity (identical exclusions), **186 pairs through the session**.
Trips: 15% fewer suite-wide, 22% median per test (preflights gone). Bytes:
median 32% MORE per test — every request is its own crossing today, paying the
module path (~85 B), envelope framing, and UNCOMPRESSED JSON (stock rides gzip)
on each one; large payloads still win big (a gantt spec: 892 KB -> 29 KB).
Wall time on localhost: ~0% (as always; shaped runs are the timing instrument).

The overhead fixes are mechanical: hash the module id on the wire, trim
envelope headers to content-type + x-* (all their code reads), enable
permessage-deflate on the session socket. The structural fix is the §6 migrate
arm: batching a method's chain into one crossing — the shadow port's
amortization, earned back for real code.

