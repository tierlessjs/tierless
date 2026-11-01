// The repo's own Playwright, pinned in package.json devDependencies so browser tests don't
// track whatever the host has installed. 1.59 is the last release whose playwright-core
// ships lib/client/*.js unbundled: tierless/playwright's zero-touch Page patching needs it
// (≥1.60 seals those classes; resolveSuitePlaywright refuses them by design), and
// pw-waits-live checks glob parity against its lib/utils/isomorphic/urlMatch.js.
//
// The browser is the host's Chromium (TIERLESS_CHROMIUM, default /opt/pw-browsers/chromium),
// not the pinned release's own build, so no browser download is needed.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
/** The pinned playwright package directory (what a suite's resolution would find). */
export const PW_DIR = path.dirname(require.resolve("playwright/package.json"));
// any: no @types/playwright in this tsconfig — chromium, browser and page are untyped here
export const playwright: any = require("playwright");
export const launch = (): Promise<any> => playwright.chromium.launch({ executablePath: process.env.TIERLESS_CHROMIUM || "/opt/pw-browsers/chromium" });
