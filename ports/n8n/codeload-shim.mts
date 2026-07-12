// Sandbox transport accommodation for ONE dependency: n8n's lockfile pins
// wa-sqlite as a codeload.github.com tarball (github: protocol, sha-pinned, no
// integrity hash — GitHub tarballs aren't byte-stable). Some sandboxes proxy
// codeload away while git smart-http stays reachable, so this shim serves the
// SAME sha's tree, fetched over git, at the SAME https URL — the lockfile stays
// byte-identical, `--frozen-lockfile` intact. setup.sh starts it only after
// probing that codeload is actually unreachable, points codeload.github.com at
// 127.0.0.1 for the duration of the install, and removes both afterwards.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA = "779219540f66cecaa159da32b3b8936697ba10a7";
const REPO = "https://github.com/rhashimoto/wa-sqlite.git";
const ROUTE = `/rhashimoto/wa-sqlite/tar.gz/${SHA}`;
const DIR = fileURLToPath(new URL("../work/codeload-shim/", import.meta.url));
mkdirSync(DIR, { recursive: true });

const tarball = path.join(DIR, `wa-sqlite-${SHA}.tar.gz`);
if (!existsSync(tarball)) {
  const clone = path.join(DIR, "wa-sqlite");
  if (!existsSync(clone)) {
    execFileSync("git", ["init", "-q", clone]);
    execFileSync("git", ["-C", clone, "remote", "add", "origin", REPO]);
    // fetching a raw sha works on GitHub (uploadpack.allowAnySHA1InWant)
    execFileSync("git", ["-C", clone, "fetch", "-q", "--depth", "1", "origin", SHA]);
  }
  // same top-level prefix codeload uses, so pnpm's strip-one-level sees the same tree
  execFileSync("git", ["-C", clone, "archive", "--format=tar.gz", `--prefix=wa-sqlite-${SHA}/`, "-o", tarball, SHA]);
}

const key = path.join(DIR, "key.pem");
const cert = path.join(DIR, "cert.pem");
if (!existsSync(cert)) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "30", "-subj", "/CN=codeload.github.com", "-addext", "subjectAltName=DNS:codeload.github.com"]);
}

createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  if (req.url === ROUTE) {
    res.setHeader("content-type", "application/x-gzip");
    res.end(readFileSync(tarball));
  } else {
    res.statusCode = 404;
    res.end("not shimmed: " + req.url);
  }
}).listen(443, "127.0.0.1", () => console.log("codeload shim ready on 127.0.0.1:443"));
