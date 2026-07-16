# Ports — rung 3 of the corpus program (docs/corpus.md)

A port is a committed RECIPE, never the target app's code: a sha-pinned public zip URL,
a sha256 of the extracted source tree (content is pinned, not the archive bytes), our
patch series, and journey files for bench/harness. `node ports/run.mts <name>` fetches
into the gitignored ports/work/, verifies the tree, applies the patches; the recipe's
README covers boot + measurement. `ports/selftest` proves the runner end to end against
this repo's own sha zip (pin mode, verification, patch apply, mismatch refusal).

New ports: what the first four carried as hand patches is now packaged — `autoSession`
(tierless/adapt-auto) + `axiosAdapter`/`fetchAdapter` for the app seam, `tierless
gateway` for the gateway, and `installTransportWaits` + `recordForceBrowserRoutes`
(tierless/playwright) + `tierless/playwright-reporter` for the suite. The app diff
should be the I/O-bottom seam plus app-specific pins; test patches only for SEMANTIC
accommodations (docs/corpus.md). The nocodb recipe is re-cut on this surface (321 → 173
patch lines — see its README); vikunja/strapi/n8n predate it and stay as measured —
re-cutting one means re-running its arms.
