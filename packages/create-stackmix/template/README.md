# A Stackmix app

| file | what |
| --- | --- |
| `app.src.js` | your program — one plain function; `api.*` runs on the server, `commit()` in the browser, Stackmix migrates the live continuation between them |
| `api.server.mjs` | the trusted service — runs as a reference-monitor sidecar in its own process; every call re-authorized against the verified principal |
| `server.mjs` | the two-tier host (`serveApp`: static + page + session endpoint) |
| `client.mjs` | the browser tier (`connect`: answer migrations, service `commit()`) |

```bash
npm install
npm run dev          # build app.src.js and serve — open the printed URL
npm run explain      # which functions compile into migratable machines, and why
npm run check:api    # pre-ship check: every endpoint states who may call it
```

Try adding an **empty** note: the monitor's per-call `authorize` rejects it in its own
process, and the denial lands in `App`'s `try/catch` — across the tier boundary.
