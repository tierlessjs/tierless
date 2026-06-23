// Capstone — SERVER tier. Owns db.items / db.title and runs migrated
// continuations of a program compiled from real TypeScript. Exposed as
// startServer() so the client can stand one up in-process over a loopback ws;
// also runnable standalone (`node examples/hn-thread/server.mjs`).
import { Tier } from "#stackmix";
import { serveWss } from "#stackmix/runtime/wss-server.mjs";
import { N, buildRuntime } from "./thread.mjs";

export function startServer(port = 0) {
  const wss = serveWss({ port }, () => ({
    rt: buildRuntime(),
    tier: new Tier("server", {
      "db.items": () => Array.from({ length: N }, (_, i) => i),
      "db.title": ([id]) => "Title #" + id,
    }),
  }));
  return new Promise((resolve) => wss.on("listening", () => resolve({ wss, port: wss.address().port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer(Number(process.env.PORT) || 0).then(({ port }) => console.log("PORT " + port));
}
