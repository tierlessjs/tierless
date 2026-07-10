// GROUND-TRUTH wire bytes for the open-project interaction, both arms.
// Counting TCP relays in front of both origins; counters reset at the click, so the
// interaction window's TRUE bytes (compressed, framed, everything) are what's reported.
// CDP can't do this: it reports ws frames post-inflate.
//   node wire-truth.mts [--baseline]
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_REQUIRE || "/opt/node22/lib/node_modules/")("playwright");
import { delayProxy, type WireCounter } from "../../latency-proxy.mts";
import { seedProjectWithTasks, API } from "../boot.mts";

const front: WireCounter = { toServer: 0, toClient: 0 };
const api: WireCounter = { toServer: 0, toClient: 0 };
delayProxy(14173, 4173, 0, front).unref();
delayProxy(13456, 3456, 0, api).unref();

const token = await seedProjectWithTasks(20);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.addInitScript(([t, a]: string[]) => {
  localStorage.setItem("token", t); localStorage.setItem("API_URL", a); (window as any).API_URL = a;
}, [token, "http://127.0.0.1:13456/api/v1"]);
console.log((process.argv.includes("--baseline") ? "BASELINE" : "PORTED") + " interaction wire truth:");
await page.goto("http://127.0.0.1:14173/");
await page.waitForTimeout(4000);                                   // warm: app booted, socket connected

const measure = async (label: string) => {
  front.toServer = front.toClient = 0; api.toServer = api.toClient = 0;
  await page.locator(".menu-list-item, .menu .list-menu a, nav a", { hasText: "First Project" }).first().click();
  await page.locator(".tasks .task").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  console.log(`  [${label}] front: ${front.toServer} out / ${front.toClient} in   api: ${api.toServer} out / ${api.toClient} in`);
};
await measure("cold (route chunks + data)");
await page.locator("nav a, .menu a", { hasText: "Overview" }).first().click();
await page.waitForTimeout(1500);
await measure("warm (chunks cached: ~data only)");

await browser.close();
process.exit(0);
