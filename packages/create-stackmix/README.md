# create-stackmix

Scaffold a running two-tier Stackmix app in under a minute:

```bash
npm create stackmix@latest my-app
cd my-app && npm install && npm run dev
```

You get one tierless program (`app.src.js`), a trusted api service running as a
reference-monitor sidecar (`api.server.mjs`), and a two-tier host — working, not a
skeleton (the scaffold is driven end to end in Stackmix's CI).

Docs: **https://github.com/bfulton/stackmix**
