# Debugging a Stackmix app

Your code compiles into `while (true) switch (F.pc)` machines, so a raw stack trace
points into generated code. These are the tools that map everything back to *your* source.

## "Which of my functions became machines, and why?"

```bash
npx stackmix explain src/actions.mjs           # human report
npx stackmix explain src/actions.mjs --json    # machine-readable (for tooling/agents)
```

Per function: compiled or pure, *why* (direct resource touches vs. calls into suspendable
functions, with the call path), and every suspension point with its tier and source line.
If a function you expected to stay native got compiled, `explain` shows the exact call
that made it suspendable.

## "My action threw — where?"

- **A monitor denial** surfaces as an `Error("denied")` rejecting the action's promise —
  or, inside the migrating function, as a normal `try/catch` catch (the denial is thrown
  *into* the continuation at the suspension point and unwinds across frames and tiers).
  The monitor deliberately does not say why (an unknown endpoint and an unauthorized call
  look identical to the caller); the *audit trail* in the service process has the reason:
  `api.audit()` records `deny:unknown` / `deny:unauthorized` / `deny:oversize` /
  `deny:ratelimited` per call.
- **A thrown error in your own code** propagates ordinarily; the pump routes it through
  the serializable handler stack, so `try/catch` works even when the throw happened on
  the other tier, one call frame down.

## "WHERE is the continuation parked right now?"

Compile with `--source-map` (or plugin `compilerOptions: { sourceMap: true }`): the
bundle then exports `frameSite(frame)` / `stackSites(stack)`, mapping any parked frame to
a portable `file:line` of the statement it suspended at — usable in logs on either tier.

## The one rule you'll hit

A tier call inside a **callback** — `items.map(x => api.f(x))`, a sort comparator, an
object method — is a *compile-time error* with the rewrite in the message (lift it to a
loop: `for (const x of items) { const r = api.f(x); … }`). This is fundamental, not a
gap: the callback runs synchronously inside native code that cannot suspend. Everything
else ordinary — loops, destructuring, optional chains, `try/finally`, labeled breaks —
compiles; `test/probes/lang-coverage.mjs` is the coverage contract.

## Perf triage

- A hot CPU loop *inside* a suspendable function pays a ~3–3.7× constant factor. Factor
  it into a pure helper (emitted verbatim, ~1.0×) — `explain` shows which is which.
- A big object crossing the wire when it shouldn't: check it exceeds the §5 threshold
  (it should travel as a ~400 B handle), or keep it out of frame locals entirely.
- `npm run bench:overhead` reproduces every number in the README on your machine.
