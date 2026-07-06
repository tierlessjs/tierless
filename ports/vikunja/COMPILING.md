# Compiling Vikunja's real code — coverage checklist

Direction (supersedes the shadow-workflow port): the app's own service layer becomes
the migrating continuation. No parallel statement of intent, no XHR interception —
the I/O bottom moves to tierless resources (patch 0005, the axios adapter) and the
compiler carries their actual code. `node ports/vikunja/compile-coverage.mts` runs
their real files through the transform; this file tracks what it finds.

## Findings (2026-07-06)

1. **Class methods are not compilation units.** All five target files "compile" as
   pass-through: the transform's unit is the top-level `export function` declaration,
   and their service layer is `export default class extends AbstractService` —
   `getAll`/`get`/`update` are methods. `programs=[]` everywhere. Compiler work:
   compile methods into PROGRAMS with `this` carried in frame state (browser-pinned
   via §5 handle where unserializable — the instances are `shallowReactive` proxies).

2. **`this.http.get(...)` is invisible to resource recognition.** The allow-list
   matches bare-identifier namespaces (`api.x(...)`, transform.cts:128). A member
   path rooted at `this` can't name a resource, so even a compiled method would hit
   the axios call as an opaque await — a migration barrier. The promising resolution:
   their `HTTPFactory()` is itself plain compilable code reading pinned globals
   (`window.API_URL`, `getToken()` — leases); a server-side twin of the instance,
   built by THEIR factory with the tierless adapter at the bottom, makes
   `this.http.*` executable on either tier. Needs: member-path resource recognition
   (or instance-level marking), and the lease mechanism for the two globals.

3. **The UI layer correctly stays put.** `useTaskList` (ref/computed/watch) is kept
   verbatim as a pure export — right outcome: the migration boundary is the service
   method call, reactivity stays in the browser.

## Status

- Patch 0005 (axios adapter at the I/O bottom) applied; suite parity run pending —
  the adapter must be behaviorally invisible before any compilation lands.
- Patches 0001/0002 (route workflow + shim) removed from the recipe: superseded.
  The measured shadow-port results live in git history and the README's record.
