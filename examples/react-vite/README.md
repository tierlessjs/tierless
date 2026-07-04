# Tierless ⨯ React + Vite

An ordinary React app with Tierless **mixed in** — three files carry the whole integration:

| file | what |
| --- | --- |
| `vite.config.mjs` | `tierless({ api: "./src/api.server.mjs" })` next to `react()` — that's the setup |
| `src/actions.mjs` | starts with `"use tierless"`: its exported functions become **actions** — plain calls from React that run as migratable continuations, the api-heavy stretch executing on the server in one round trip |
| `src/api.server.mjs` | the **trusted service** (`defineApi` + `sidecarMain`): the plugin forks it as a reference-monitor sidecar in its own process; every `api.*` call is authorized there against the session's verified principal |

The React side is one hook:

```jsx
const plan = useAction(rebalance);
<button onClick={() => plan.run(holdings, 0.2)} disabled={plan.running}>Rebalance</button>
```

Run it:

```bash
npm install
npm run dev     # open the printed URL, click "Rebalance"
```

What to notice:

- `rebalance` in `actions.mjs` is a plain loop over `api.getQuote` / `api.placeOrder` — no
  `async`, no `fetch`, no endpoint definitions, no request/response shuttling. N api calls
  cost **one** page↔server round trip, because the continuation migrates to the server and
  runs the loop next to the service.
- The api implementation never enters the page bundle or even the dev-server process — the
  plugin forks it as a **sidecar** and the server holds only a pipe and a session token.
  Delete the `login:` line in `vite.config.mjs` and the buy/sell click shows a live denial:
  reads still work (they're `PUBLIC`), the order placement is refused by the monitor.
- Production shape: build the actions module with the same plugin, then serve it with
  `serveApp({ bundle, session, staticRoot, page })` from `tierless/server` (as
  [`server.prod.mjs`](./server.prod.mjs) does) — `serveApp` wraps `attachTierless`, the same
  session endpoint the dev plugin hosts.
