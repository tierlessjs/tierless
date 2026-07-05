# Ports — rung 3 of the corpus program (docs/corpus.md)

A port is a committed RECIPE, never the target app's code: a sha-pinned public zip URL,
a sha256 of the extracted source tree (content is pinned, not the archive bytes), our
patch series, and journey files for bench/harness. `node ports/run.mts <name>` fetches
into the gitignored ports/work/, verifies the tree, applies the patches; the recipe's
README covers boot + measurement. `ports/selftest` proves the runner end to end against
this repo's own sha zip (pin mode, verification, patch apply, mismatch refusal).
