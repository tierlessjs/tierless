// One measured arm of the suite benchmark (docs/corpus.md, run protocol): ensure the
// dist has their CI's TESTING flag, boot the variant, run the FULL Playwright suite
// with the measure fixture on, tear down. One command per arm, so no by-hand step can
// diverge between them:
//
//   node ports/vikunja/suite.mts --baseline     -> ports/work/vikunja-baseline/measure.jsonl
//   node ports/vikunja/suite.mts                -> ports/work/vikunja/measure.jsonl
//   node ports/report.mts ports/work/vikunja-baseline/measure.jsonl ports/work/vikunja/measure.jsonl
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootVikunja, TESTING_TOKEN } from "./boot.mts";

const VARIANT = process.argv.includes("--baseline") ? "vikunja-baseline" : "vikunja";
const SRC = fileURLToPath(new URL(`../work/${VARIANT}/src/`, import.meta.url));
const OUT = fileURLToPath(new URL(`../work/${VARIANT}/measure.jsonl`, import.meta.url));

// their CI injects window.TESTING=true into the BUILT index.html (test.yml, "Inject
// testing flag"); the app gates test-only behavior on it and a dozen specs fail on any
// build without it — stock included.
const idx = path.join(SRC, "frontend/dist/index.html");
const html = readFileSync(idx, "utf8");
if (!html.includes("window.TESTING")) writeFileSync(idx, html.replace("<head>", "<head><script>window.TESTING=true;</script>"));

rmSync(OUT, { force: true });
const app = await bootVikunja();
try {
  execFileSync("corepack", ["pnpm", "exec", "playwright", "test", "--reporter=line"], {
    cwd: path.join(SRC, "frontend"),
    stdio: "inherit",
    env: {
      ...process.env,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: "1",
      // their playwright.config honors this; needed where the pinned @playwright/test
      // version doesn't match the locally installed browsers
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || existsSync("/opt/pw-browsers/chromium")
        ? { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/opt/pw-browsers/chromium" } : {}),
      TEST_SECRET: TESTING_TOKEN,
      VIKUNJA_SERVICE_TESTINGTOKEN: TESTING_TOKEN,
      TIERLESS_MEASURE_OUT: OUT,
    },
  });
} catch { /* nonzero exit = some tests failed; every attempt is in the JSONL regardless */ }
app.close();
console.log(`\nmeasured arm (${VARIANT}): ${path.relative(process.cwd(), OUT)}`);
