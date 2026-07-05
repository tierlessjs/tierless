# The corpus program — a statistical claim, not a demo

Goal: a defensible sentence of the form "across N real apps' own user journeys:
median X× less network wait, Y% less IO." One curated demo can't produce it; a
population of other people's apps can. Four rungs, each independently useful:

1. **Measurement harness** (`bench/harness/` — built). Playwright + CDP measures a
   scripted journey's real network behavior: per-request HTTP wire bytes, per-frame
   websocket bytes both directions, round trips, raw wall. Verified against socket
   ground truth (`bench/harness/verify.mts`: ws within a few bytes, HTTP within ~1%).
   Journeys are plain Playwright functions, so an app's existing e2e tests adapt in
   minutes.

2. **REST-proxy adapter + gateway** (folds into rung 3). Resources are an allow-listed
   namespace with an exec, so an adapter can declare an app's existing REST endpoints as
   `api.*` — no backend rewrite. The server host deploys as a thin gateway colocated
   with the backend: client↔server RTTs collapse into one migration; gateway↔backend
   hops are localhost.

3. **Porting recipe.** Per workflow, the client-side fetch/thunk orchestration becomes
   one plain sequential function entering through the Vite seam. Mechanical enough for
   an agent-assisted codemod; hardened on 2–3 real open-source apps end to end. What
   breaks here (auth flows, uploads, optimistic UI) is the compiler/runtime's
   requirements list.

4. **Corpus study.** 10–20 popular open-source apps **with e2e suites** — their tests
   define the journeys, not us. Port with the rung-3 tool, measure before/after with
   the rung-1 harness, report the **median and the full distribution per journey**,
   losers included. A journey dominated by backend compute won't move; showing that is
   what makes the rest credible.

## Honesty constraints (bind all rungs)

- **Bytes and trips are measured; latency is modeled.** CDP's network throttling does
  not apply to websockets (long-standing Chromium limitation), so real throttling would
  bias exactly the before(HTTP)/after(ws) comparison. Latency claims are computed from
  measured (trips, bytes) under a declared RTT/bandwidth model — the same pattern as
  `bench/conduit.mts` — with the model parameters printed beside every number.
- **Workload selection is not ours.** Journeys come from the target app's own e2e
  suite, by a fixed rule (e.g. every journey tagged smoke/critical), chosen before
  measurement.
- **Distributions, not means.** Per-journey numbers, median highlighted, no aggregation
  across apps without the spread.
