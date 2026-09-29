# Keycloak — corpus app #8

Keycloak 26.7.0's admin console (`js/apps/admin-ui`), ported at the
`@keycloak/keycloak-admin-client` fetch seam. First JAVA backend in the corpus, first
fetch-based client (four earlier ports used axios, grafana used rxjs `fromFetch`), and
first OIDC **bearer** auth rather than cookies — so no `--cookie-authority`, which every
cookie-auth port has needed.

## Results

Read `docs/corpus.md` "Reading a byte number" first: the same bytes give three numbers
20x apart depending on the denominator.

| | baseline | ported | delta |
|---|---|---|---|
| suite total | 3086 MB | 3022 MB | **−2.1%** |
| marginal (what a warm cache still fetches) | 241 MB | 109 MB | **−54.9%** |
| the many-small slice (traffic the port moved) | 159 MB | 24 MB | **−84.9%** |
| wall clock, 421 pass-parity pairs | 19.7 min | 20.0 min | +1% |

The moved traffic is 100% small responses (0% bulk) across 1030 paths. Two truth pairs
agree: slice −84.9% / −85.5%, marginal −54.9% / −55.8%. The suite total does not
(−2.1% / −5.6%): 92% of it is the console's own bundle, re-downloaded because the harness
gives every test a cold browser.

Wall is parity. Two floor pairs agree: +8 ms and +28 ms median per test.

**Most of the slice is one uncompressed endpoint.** `/admin/serverinfo` is 138 of the
159 MB: ~323 KB, fetched on every console load, and stock Keycloak sends it uncompressed
(322,875 B on the wire against a 322,838 B plaintext frame). The session's
permessage-deflate compresses it; stock HTTP does not. So this −85% mostly measures
compression the stock server skips, not per-request overhead, and session bytes are one
counter, so serverinfo's share of the 24 MB can't be split out. The fair comparison is a
gzip-baseline arm (nocodb's `drive-apples.sh`); it has not been run.

## Chain migration: fewer round trips, measured

The numbers above move one call per crossing. This measures the thing Tierless is for:
several calls in a row running as ONE crossing.

**The measure is I/O wait**: per test, the time the page has at least one fetch or
session crossing in flight, the union of those intervals, each ended at network
completion (`ports/report-io.mts`). HTTP is timed by the browser's network timing
(`installIoWait`, test patch 0005 on both arms); crossings by the latency relay in front
of the session socket (`wsIoTap`). Browser-side frame events can't time crossings: they
wait for the page's main thread (a 100 ms crossing during 300 ms of page CPU reads 321 ms
there, 107 ms in the relay). Wall clock also carries render, fixtures and Playwright's
100/250/500/1000 ms retry polling, so it's shown for reference only.

All runs: 80 ms injected RTT, three rounds per arm, arms interleaved within each round
(`drive-chains.sh`; rows and labelled intervals in `results/chains/` and
`results/flows/`), per-test medians summed over tests passing in every run of both arms.
Arms: stock; ported with nothing migrating; ported migrating on a locked profile from a
profiling run over the same specs (132 and 54 migrated crossings over the three rounds; 0
in the nothing-migrating arm).

| | migration alone (same build) | against stock | wall, migration alone |
|---|---|---|---|
| client scopes (2 specs, 21 tests) | **−18.3%** (36.2 → 29.6 s), 19 of 21 less, median −327 ms | −17.6% (35.9 → 29.6 s) | −7.6% |
| flows (1 spec, 23 tests) | **−2.5%** (27.7 → 27.0 s), 12 of 23 less, median −2 ms | −0.1% (27.0 → 27.0 s) | +0.5% |

The ported build with nothing migrating waits +0.8% (client scopes) / +2.4% (flows) more
than stock. Per call a crossing costs the same as HTTP (median per-endpoint difference 0–1
ms over 25 and 35 endpoints). The measurable extra is `/admin/serverinfo`: 323 KB on
every console load, 136–137 ms per load against 122–125 ms stock, because the gateway
receives the whole body before forwarding it (locally, a 456 KB body takes 20.8 ms over a
crossing against 9.2 ms over HTTP). The gateway itself adds under 1 ms per call (request
in to reply out: 14 ms, of which Keycloak 14 ms). On flows that cost cancels the gain, so
there is no net improvement over stock there.

**Client scopes: independent calls.** The client-scopes page's loader
(`ClientScopesSection.tsx`) and the client's scopes tab (`clients/scopes/ClientScopes.tsx`)
each make three `await adminClient.clientScopes…` calls in a row inside a React component.
Patch 0004 compiles them (`compile: 'auto'` + `closures`); a session twin of the admin
client serves the calls on the gateway, so each loader run is one crossing instead of
three. The scopes-tab and creation tests gain 470–680 ms of I/O wait each. These calls don't depend on
each other, so `Promise.all` in the app would save the same round trips: this shows the
mechanism on unmodified code, not a win the app couldn't get otherwise.

**Flows: dependent calls.** `Promise.all` can't collapse a call that needs the previous
one's result. The flow details page's loader (`FlowDetails.tsx`) is one: `getFlows()`,
find the flow by the route's `id`, throw `new Error(t("notFound"))` if missing, then
`getExecutions({ flow: flow.alias })`. It reads borrowed variables between the calls: `id`
is a string and travels with the run, and `t()` sits on a branch not taken, which the stop
rule skips. On a verification run over the spec, all 17 migrations finished on the gateway
(none went back to the browser mid-chain) and the browser fetched `/executions` 0 times.
The flow-details tests gain 100–200 ms of I/O wait each; the spec's other tests don't
load that page.

One test changes outcome: `flows.spec.ts:217 › edits flow details` failed in 15 of 18 stock
and nothing-migrating runs across three batches, and in 0 of 9 migrating runs.
`EditFlowModal` is rendered with `flow!`, which stays undefined until this loader
finishes; at 80 ms RTT the test clicks "Edit info" first and the submit throws reading
`flow.id`. The migrating loader finishes one round trip sooner. It's a race, so this
shows the latency moved, not a fix.

Of the 6 dependent chains in the console, 3 now run in one crossing (this loader,
`identity-providers/add/AdvancedSettings.tsx`'s loader, `DuplicateFlowModal`'s submit).
The other 3 return to the browser mid-chain: a translated string as a call argument
(`ResetPasswordDialog`), a nested borrowed object (`user.id`), and an imported helper
(`convertFormValuesToObject` in `LinkIdentityProviderModal`). The permissions tab maps an
async function over a list, which doesn't compile yet.

## Running it

```sh
bash ports/keycloak/setup.sh              # ported arm
bash ports/keycloak/setup.sh --baseline   # stock arm
bash ports/keycloak/drive-pair.sh                 # floor arms (wall clock)
MODE=truth bash ports/keycloak/drive-pair.sh      # truth+budget arms (bytes)
```

The distribution zip (168 MB) is shared by both arms; what differs is the one
`org.keycloak.keycloak-admin-ui-26.7.0.jar` we rewrite with this arm's console build. The
Java server is byte-identical in both arms — a stronger control than building it twice.

## Two things the server has to be told, or the suite measures nothing

**`--features`.** Their Admin UI E2E job starts the server with a feature list
(`.github/workflows/js-ci.yml`, job `admin-ui-e2e`), and 11 of the suite's 68 spec files
exercise UI that only exists when the matching feature is on: 4 oid4vci, 2 workflows, 2
permissions (`admin-fine-grained-authz:v2`), and one each for spiffe,
kubernetes-service-accounts and jwt-authorization-grant. Booting bare fails them on both
arms. `boot.mts` holds the list verbatim; `setup.sh` reads the same constant for its
snapshot boot, so the pristine database carries the schema those features create.

**`--hostname`.** Keycloak derives a realm's OIDC issuer from the request Host unless
pinned, and validates bearer tokens against it. The ported arm is the only arm reached by
TWO hosts — the browser logs in through the measurement relay (`:28080` truth, `:18080`
RTT) while admin-API crossings ride the session and arrive from the gateway on `:8080` —
so its token was minted for the relay host and rejected 401 on the backend host. The
console rendered "HTTP 401 Unauthorized" and every spec timed out. `boot.mts` takes the
browser-facing origin and pins it, which makes the issuer constant on both ports.

It hid because the two arms that work are the two that use one host: the baseline never
opens a session, and an unshaped ported arm has page and backend both on `:8080`. Only
ported+relay splits them — which is every arm that produces a byte number.

## Known failures

Three specs fail on BOTH arms and are environmental or upstream, not the port —
`identity-providers/default-trust.spec.ts:33`, `identity-providers/oidc.spec.ts:36` (it
fetches a discovery URL) and `identity-providers/saml-signature-defaults.spec.ts:7`.
`clients/advanced.spec.ts:176` fails against the STOCK bundle too, verified in isolation.
`realm-roles/main.spec.ts:117`, `realm-settings/events.spec.ts:33` and
`identity-providers/saml.spec.ts:78` are flaky on both arms across runs; a failure
cascades, because Playwright skips the rest of a describe, which is why a 1-test failure
moves the pass count by 7. Pass-parity gating excludes them from every number above.
