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
| marginal (what a warm cache still fetches) | 2726 MB | 2655 MB | **−2.6%** |
| bytes over 413 pass-parity pairs (`ports/report.mts`) | 2951 MB | 2847 MB | **−4%** |
| wall clock, 421 pass-parity pairs | 19.7 min | 20.0 min | +1% |

Wall is parity. Two floor pairs agree: +8 ms and +28 ms median per test, 19.7 → 19.7 and
19.7 → 20.0 min. The port neither costs nor buys time on this app.

**The many-small slice is NOT separable on this app, and that is the honest headline.**
The port moves 2717 MB of baseline traffic onto the session and pays 24 MB for it
(−99.1%), but 43% of those moved bytes are BULK (>1 MB responses), and session bytes are
a single counter — per-message sizes are unobservable through one deflate window. So that
−99.1% is dominated by the compression delta on a few huge payloads, not by the
many-small effect the corpus is testing. **The request-shape predictor is untested here.**
Isolating it needs bulk kept OFF the socket first, the way n8n's browse advisory does it
(`ports/n8n/report-smallslice.mts`, −50.7%).

Why the suite-wide number is small: the console re-fetches its own bundle every test —
patternfly's CSS, `main-*.css`, `main-*.js` and `CodeEditor-*` are ~70% of marginal bytes
in BOTH arms — and the harness has no warm cache, so those repeats swamp the admin API
the port actually carries. The session's 24 MB is 0.79% of suite total; that share is the
ceiling on any byte win here, and it held identical across two independent pairs.

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
