# my-stackmix-app

A starter [Stackmix](https://github.com/bfulton/stackmix) app. One program,
authored as ordinary TypeScript, that runs across a server tier and a client
tier — the runtime migrates the live computation to wherever the next resource
lives, instead of you splitting it by hand.

```bash
npm install
npm start
```

## Files

- `app.ts` — the application. No tier annotations; placement is inferred from the
  resources it touches (`db.*` = server, `ui.*` = client).
- `app.mjs` — the host: compiles `app.ts`, wires up the two tiers, and runs the
  migration loop in a single process.

## Where to go next

`app.mjs` runs both tiers in one process for simplicity. To make the program span
two real processes (or two machines), replace the in-process oscillator with a
socket that carries the serialized continuation between them — the continuation is
plain data you own. See the [Stackmix examples](https://github.com/bfulton/stackmix/tree/main/examples)
for the cross-process and benchmark versions.

> During local development, before Stackmix is published to npm, link the
> framework into this project with `npm link stackmix` from a checkout.
