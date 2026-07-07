// The per-process connection cap: sessions beyond maxConnections are refused at the
// upgrade (HTTP 503) without touching established ones, and a closed session frees its
// slot. This is what makes the per-connection budgets (the §5 cache above all) a finite
// process ceiling: memory is bounded by cap x budget, not by how many sockets arrive.
import { createRequire } from "node:module";
import { serveApp, WS_PATH, DEFAULT_MAX_CONNECTIONS } from "tierless/server";
import type { Bundle } from "tierless/runtime";
import { makeCheck } from "../lib/check.mts";

const { WebSocket } = createRequire(import.meta.url)("ws");
const { check, ok } = makeCheck();
console.log("Probe: the per-process connection cap — over-cap upgrades refused, slots freed on close\n");

check(`the default cap is a process-wide constant (${DEFAULT_MAX_CONNECTIONS})`, DEFAULT_MAX_CONNECTIONS === 100);

const bundle: Bundle = { PROGRAMS: {}, __unwind: () => false };
const app = await serveApp({ bundle, session: () => ({ exec: () => 0 }), maxConnections: 2 });
const url = `ws://localhost:${app.port}${WS_PATH}`;

// open() resolves "open" | "refused" — a refused upgrade surfaces as a handshake error.
const open = (): Promise<{ state: string; ws: any }> => new Promise((resolve) => {
  const ws = new WebSocket(url);
  ws.on("open", () => resolve({ state: "open", ws }));
  ws.on("error", () => resolve({ state: "refused", ws }));
});
const closed = (ws: any): Promise<void> => new Promise((r) => { ws.on("close", () => r()); ws.close(); });
const retryOpen = async (tries: number): Promise<{ state: string; ws: any }> => {   // TCP close needs a beat to reach the server's counter
  let last = await open();
  while (last.state !== "open" && --tries > 0) { await new Promise((r) => setTimeout(r, 50)); last = await open(); }
  return last;
};

const first = await open();
const second = await open();
check("connections within the cap are accepted", first.state === "open" && second.state === "open");

const third = await open();
check("a connection beyond the cap is refused at the upgrade (503, no session)", third.state === "refused");
check("the refusal did not disturb the established sessions", first.ws.readyState === 1 && second.ws.readyState === 1);

await closed(first.ws);
const fourth = await retryOpen(40);
check("closing a session frees its slot — the next connection is accepted", fourth.state === "open");

const fifth = await open();
check("the cap holds again at the new census", fifth.state === "refused");

for (const c of [second, fourth]) c.ws.close();
app.close();
console.log(ok()
  ? "PASS — the per-process connection cap refuses over-cap upgrades with 503, spares live sessions, and recycles freed slots"
  : "FAIL");
process.exit(ok() ? 0 : 1);
