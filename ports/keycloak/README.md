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
