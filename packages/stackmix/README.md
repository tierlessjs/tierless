# Stackmix

**Your page makes 8 API calls to render one view. Stackmix runs that whole workflow
server-side in ONE round trip — without you writing the endpoint.**

You write the workflow as one plain JavaScript function; Stackmix compiles it into a
serializable state machine and migrates the live continuation between browser and server
at the resource calls. Every `api.*` is authorized per call by a reference monitor in its
own process. ~140 B / ~2.5 µs per hop; data you don't touch stays home behind a ~400 B
handle; 7.1 kB gzipped in the browser.

```js
// vite.config.mjs
import stackmix from "stackmix/vite";
export default { plugins: [react(), stackmix({ api: "./src/api.server.mjs" })] };
```

```js
// src/actions.mjs
"use mix";
export function rebalance(holdings) {
  const orders = [];
  for (const h of holdings) {
    const px = api.getQuote(h.sym);
    if (px > h.limit) orders.push(api.placeOrder({ sym: h.sym, qty: h.qty }));
  }
  return orders;
}
```

Full docs, the evidence (33 executable proofs), examples, and the honest
production/when-not-to-use notes: **https://github.com/bfulton/stackmix**
