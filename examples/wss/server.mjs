// Stackmix — WSS demo SERVER. Binds a ws endpoint; each connection gets its own
// server tier owning db.profile (a big object that must stay server-side). The
// browser-only `render` resource is deliberately absent here, so a continuation
// that reaches it migrates back.
//
//   node examples/wss/server.mjs            # listens on $PORT or an ephemeral port; prints it
//
// Also exported as startServer() so the client demo can stand one up in-process.
import { Tier } from "#stackmix";
import { serveWss } from "#stackmix/runtime/wss-server.mjs";
import { buildRuntime, BIO } from "./app.mjs";

export function startServer(port = 0) {
  const wss = serveWss({ port }, () => ({
    rt: buildRuntime(),
    tier: new Tier("server", {
      "db.profile": ([id]) => ({ id, name: "Profile " + id, bio: "X".repeat(BIO) }),
    }),
  }));
  return new Promise((resolve) => wss.on("listening", () => resolve({ wss, port: wss.address().port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer(Number(process.env.PORT) || 0).then(({ port }) => console.log("PORT " + port));
}
