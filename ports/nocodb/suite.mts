// One measured arm of the NocoDB suite (docs/corpus.md run protocol): boot the
// variant, run THEIR Playwright suite (sqlite lane, their workers=1 config) with the
// measure fixture on, tear down. One command per arm, so no by-hand step can diverge:
//
//   node ports/nocodb/suite.mts --baseline    -> ports/work/nocodb-baseline/measure.jsonl
//   node ports/nocodb/suite.mts               -> ports/work/nocodb/measure.jsonl
//   TIERLESS_SPEC=tests/db/general node ports/nocodb/suite.mts   (subset iteration)
//
// RTT shaping and wire-truth counting arrive with the ported arm (their
// playwright.config hardcodes baseURL :3000 — the BASE_URL override is part of the
// measure-fixture test patch, applied to both arms).
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootNocodb } from "./boot.mts";

const VARIANT = process.argv.includes("--baseline") ? "nocodb-baseline" : "nocodb";
const SRC = fileURLToPath(new URL(`../work/${VARIANT}/src/`, import.meta.url));
const OUT = fileURLToPath(new URL(`../work/${VARIANT}/measure.jsonl`, import.meta.url));

rmSync(OUT, { force: true });
const app = await bootNocodb();
// --workers=1 pins THEIR CI sqlite-lane concurrency (their config sets it only under
// CI=true, which flips retries/forbidOnly too — the explicit flag takes just the part
// that matters: one shared sqlite backend cannot serve 4 racing browser contexts)
const suite = spawn("corepack", ["pnpm", "exec", "playwright", "test", "--workers=1", ...(process.env.TIERLESS_SPEC || "").split(/\s+/).filter(Boolean)], {
  cwd: path.join(SRC, "tests/playwright"),
  stdio: "inherit",
  env: {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    E2E_DB_TYPE: "sqlite",
    PLAYWRIGHT_BROWSERS_PATH: path.join(process.env.HOME || "", "pw-browsers"),
    TIERLESS_MEASURE_OUT: OUT,
  },
});
await new Promise<void>((resolve) => suite.on("exit", () => resolve()));   // nonzero = some tests failed; every attempt is in the JSONL regardless
app.close();
console.log(`\nmeasured arm (${VARIANT}): ${path.relative(process.cwd(), OUT)}`);
