// The force-browser matcher's URL-glob semantics: Playwright resolves a RELATIVE
// route glob against baseURL before matching, so descriptors matched against full
// URLs must absolutize relative globs — grafana's migrate-to-cloud mocks used
// "api/cloudmigration/..." patterns that could otherwise never fire, and mocked
// requests crossed the session past the mock. Absolute/starred globs are untouched.
//
// Run:  node test/probes/url-glob.mts
import { matchesForceBrowser } from "tierless/playwright";
import { makeCounter } from "../lib/check.mts";

const { check, counts } = makeCounter();
const M = (glob: string, url: string): boolean => matchesForceBrowser([{ glob }], url);

check("relative glob (no slash) matches any origin, like a baseURL-resolved route",
  M("api/cloudmigration/migration/uid1/snapshots?page=1&limit=1*", "http://localhost:3001/api/cloudmigration/migration/uid1/snapshots?page=1&limit=1&x=2"));
check("root-relative glob matches too", M("/api/foo", "http://app.local:3000/api/foo"));
check("relative glob still anchors its own path: a different path misses",
  !M("api/foo", "http://app.local:3000/api/foobar"));
check("** glob unchanged", M("**/rest/thing", "https://x.example/rest/thing"));
check("absolute glob unchanged (exact origin only)",
  M("http://a.local/api/x", "http://a.local/api/x") && !M("http://a.local/api/x", "http://b.local/api/x"));
check("query-stripped candidate still consulted", M("/api/q", "http://a.local/api/q?anything=1"));

const { pass, fail } = counts();
console.log(fail === 0 ? `OK — force-browser globs match with Playwright's baseURL-relative semantics (${pass} checks)` : `FAIL (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
