# create-tierless

Scaffold a running two-tier Tierless app in under a minute:

```bash
npm create tierless@latest my-app
cd my-app && npm install && npm run dev
```

You get one tierless program (`app.src.js`), a trusted api service running as a
reference-monitor sidecar (`api.server.mjs`), and a two-tier host — working, not a
skeleton (the scaffold is driven end to end in Tierless's CI).

Docs: **https://github.com/tierlessjs/tierless**
