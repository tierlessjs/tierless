// Journey: OPEN A PROJECT — the interaction behind Vikunja's own
// tests/e2e/project/project-view-list.spec.ts, measured through bench/harness.
//
// Setup (outside the measured browser): seed one user, one project with the four default
// views, and 20 tasks through THEIR testing API (the same factories their e2e suite
// uses), then log in via API and inject the token the way their authenticateUser.ts
// does. The measured interaction is the warm-SPA click: the app sits on the home
// screen, the user clicks the project — everything that crosses the wire until the
// task list renders is the journey. Only API-origin traffic counts (the frontend's
// static assets are the SPA bundle, identical before and after any port).
//
//   node ports/vikunja/journeys/project-view.mts
import { measureJourney, printReport, modelWallMs, fmt } from "../../../bench/harness/measure.mts";
import { bootVikunja, seedProjectWithTasks, API, FRONT } from "../boot.mts";

const app = await bootVikunja();
try {
  const token = await seedProjectWithTasks(20);

  const report = await measureJourney(FRONT, async (page) => {
    await page.locator(".menu-list-item, .menu .list-menu a, nav a", { hasText: "First Project" }).first().click();
    await page.locator(".tasks .task").first().waitFor({ timeout: 15_000 });
  }, {
    // journey = the data path: API-origin HTTP plus the tierless session socket (AFTER
    // builds route data over it). The SPA bundle is identical either way and excluded.
    ignore: (url) => !url.startsWith(API) && !url.includes("/__tierless"),
    prepare: async (page) => {
      await page.addInitScript(([t, api]: string[]) => {
        window.localStorage.setItem("token", t);
        window.localStorage.setItem("API_URL", api);
        (window as any).API_URL = api;
      }, [token, API + "/api/v1"]);
    },
  });

  const variant = report.ws.framesOut > 0 ? "AFTER (tierless route workflow)" : "BEFORE (stock v1.0.0)";
  printReport(`vikunja · open a project (20 tasks) · ${variant}`, report);
  console.log(`  modeled network wait @ 80 ms RTT / 10 Mbps: ${modelWallMs(report).toFixed(0)} ms\n`);
  console.log("  the interaction's API waterfall:");
  for (const r of report.requests) console.log(`    ${r.method.padEnd(5)} ${r.url.replace(API, "")}  ${fmt(r.bytesOut)} out / ${fmt(r.bytesIn)} in`);
  for (const s of report.sockets) console.log(`    WS    ${s.url.replace(/\?token=.*/, "?token=…")}  ${s.framesOut}->/${s.framesIn}<-  ${fmt(s.bytesOut)} out / ${fmt(s.bytesIn)} in`);
} finally {
  app.close();
}
