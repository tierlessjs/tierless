// Fetch a PINNED Test262 snapshot into test/test262/vendor/ (gitignored).
//
// The corpus is ~50k files / >50 MB, so it is not committed; this script
// downloads the one tarball codeload serves for the pinned commit and extracts
// just the harness and the language tests (what the runner targets). Re-run it in
// a fresh checkout / container before running run262.mjs.
//
// Pinned for reproducibility — bump COMMIT to update the snapshot.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = "de8e621cdba4f40cff3cf244e6cfb8cb48746b4a"; // tc39/test262 main @ 2026-06
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "vendor");
const TARBALL = path.join(VENDOR, ".t262.tar.gz");

fs.mkdirSync(VENDOR, { recursive: true });
console.log(`Fetching test262 @ ${COMMIT.slice(0, 12)} (one tarball, ~9.5 MB)…`);
// codeload serves the archive over plain HTTPS (the git relay is restricted, but
// this host is reachable). curl honors the agent proxy + CA bundle from the env.
execSync(`curl -fsSL -o "${TARBALL}" "https://codeload.github.com/tc39/test262/tar.gz/${COMMIT}"`, { stdio: "inherit" });

console.log("Extracting harness/ and test/language/ …");
execSync(`tar -xzf "${TARBALL}" -C "${VENDOR}" --strip-components=1 "test262-${COMMIT}/harness" "test262-${COMMIT}/test/language" "test262-${COMMIT}/LICENSE"`, { stdio: "inherit" });
fs.rmSync(TARBALL, { force: true });

const count = (dir) => (fs.existsSync(dir) ? execSync(`find "${dir}" -name '*.js' | wc -l`).toString().trim() : "0");
console.log(`\nDone. ${count(path.join(VENDOR, "test/language"))} language tests under ${path.relative(process.cwd(), VENDOR)}/`);
console.log("Run:  node test/test262/run262.mjs [chapter ...]");
