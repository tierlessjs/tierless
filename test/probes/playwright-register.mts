// tierless/playwright-register — the NODE_OPTIONS delivery channel for suites whose
// own runner generates Playwright configs (Strapi-shaped: `--config` isn't ours to
// pass). This probe spawns real node children with the preload, the way a suite
// driver's environment reaches every worker, and pins: the suite's playwright-core
// Page class gets the transport-agnostic waits; without TIERLESS_SUITE_DIR the preload
// is inert; a child that can't resolve playwright-core stays silent (app servers).
//
// Run:  node test/probes/playwright-register.mts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeCounter } from "../lib/check.mts";

const { check, counts } = makeCounter();
const REGISTER = fileURLToPath(new URL("../../packages/tierless/src/playwright-register.cjs", import.meta.url));
const PW_DIR = "/opt/node22/lib/node_modules/playwright";

const PROBE = `
const { createRequire } = require("node:module");
const req = createRequire(${JSON.stringify(PW_DIR)} + "/x.js");
const core = req.resolve("playwright-core/package.json").replace(/\\/package\\.json$/, "");
const { Page } = require(core + "/lib/client/page.js");
console.log(String(Page.prototype.waitForResponse).includes("firstCrossing") || String(Page.prototype.waitForResponse).includes("wirePage") ? "PATCHED" : "STOCK");
`;

const run = (env: Record<string, string | undefined>): string =>
  spawnSync(process.execPath, ["--require", REGISTER, "-e", PROBE], { encoding: "utf8", env: { ...process.env, TIERLESS_SUITE_DIR: undefined, ...env } }).stdout.trim();

check("with TIERLESS_SUITE_DIR, the suite's Page class is patched in the child", run({ TIERLESS_SUITE_DIR: PW_DIR }) === "PATCHED");
check("without TIERLESS_SUITE_DIR, the preload is inert (stock class)", run({}) === "STOCK");
{
  const r = spawnSync(process.execPath, ["--require", REGISTER, "-e", "console.log('APP OK')"], { encoding: "utf8", env: { ...process.env, TIERLESS_SUITE_DIR: "/nonexistent/suite" } });
  check("a child that can't resolve playwright-core runs silently (app servers)", r.stdout.trim() === "APP OK" && !r.stderr.includes("tierless"), r.stderr.slice(0, 120));
}

const { pass, fail } = counts();
console.log(fail === 0
  ? `OK — playwright-register delivers the waits through NODE_OPTIONS: patched when aimed at a suite, inert without the gate, silent in non-suite children (${pass} checks)`
  : `FAIL (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
