// Journey: the example app's "Rebalance" interaction, measured through the harness.
// Boots the example's production server (requires a prior `npx vite build` in
// examples/react-vite), drives the real page, reports interaction bytes/trips.
//
//   node bench/harness/journeys/react-vite.mts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { measureJourney, printReport, modelWallMs, fmt } from "../measure.mts";

const appDir = fileURLToPath(new URL("../../../examples/react-vite/", import.meta.url));
if (!existsSync(appDir + "dist/index.html") || !existsSync(appDir + "dist-tierless/tierless.manifest.json")) {
  console.error("build the example first: cd examples/react-vite && npm install && npx vite build");
  process.exit(2);
}

const PORT = 8931;
const srv = spawn(process.execPath, ["server.prod.mjs"], { cwd: appDir, env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
await new Promise<void>((res, rej) => {
  srv.stdout.on("data", (d) => { if (String(d).includes("production server")) res(); });
  srv.on("exit", () => rej(new Error("server died")));
});

try {
  const report = await measureJourney(`http://localhost:${PORT}/`, async (page) => {
    await page.getByRole("button", { name: /Rebalance/ }).click();
    await page.getByText(/orders placed/).waitFor({ timeout: 10_000 });
  });
  printReport("react-vite · Rebalance (tierless prod build)", report);
  console.log(`  modeled network wait @ 80 ms RTT / 10 Mbps: ${modelWallMs(report).toFixed(0)} ms`);
  console.log(`\nThe interaction is ${report.trips} trip(s) and ${fmt(report.totalBytes)} on the wire — the numbers a before/after`);
  console.log("comparison uses once a ported app's original build is measured with the same journey.");
} finally {
  srv.kill();
}
