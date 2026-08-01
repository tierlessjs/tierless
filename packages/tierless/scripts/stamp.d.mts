// Hand-written: scripts/ is a build script, outside the src/ compile that generates types/.
// ports/assert-fresh.mts imports sourceHash from it under strict typecheck.

/** sha256 over the package's .mts sources, sorted by path; first 16 hex chars. */
export function sourceHash(): string;
