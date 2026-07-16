// NODE_OPTIONS delivery of the transport-agnostic waits — for suites whose OWN runner
// generates Playwright configs and invocations (Strapi's run-tests.js), where the
// `--config` wrapper channel (ports/pw-wrapper.mts) isn't ours to pass. The standard
// Node instrumentation mechanism instead:
//
//   NODE_OPTIONS="--require <abs>/playwright-register.cjs" TIERLESS_SUITE_DIR=<suite> <their runner>
//
// Every node child inherits it — the Playwright runner AND its worker processes — so
// patchPlaywrightPages reaches every page with the target tree pristine. Gated on
// TIERLESS_SUITE_DIR; in non-Playwright children (the app's own dev server) it merely
// loads playwright-core's client classes and patches prototypes nothing constructs —
// wasted bytes, no behavior. TIERLESS_WS_URL (shaped runs) rides an init script into
// every context as the adapt-auto localStorage override.
const suiteDir = process.env.TIERLESS_SUITE_DIR;
if (suiteDir) {
  try {
    // require(esm): playwright.mjs has no top-level await (Node >= 22.12)
    const pw = require("./playwright.mjs") as typeof import("./playwright.mjs");
    pw.patchPlaywrightPages(pw.resolveSuitePlaywright(suiteDir), {
      initScript: process.env.TIERLESS_WS_URL
        ? `localStorage.setItem('tierlessWsUrl', ${JSON.stringify(process.env.TIERLESS_WS_URL)})`
        : undefined,
    });
  } catch (err) {
    // a child that can't resolve the suite's playwright-core is not running tests
    if (process.env.TIERLESS_REGISTER_DEBUG) console.warn("[tierless/playwright-register] " + (err as Error).message);
  }
}
