"use mix";
// The tier-fluid part of the app. Ordinary JavaScript — no async, no fetch, no RPC
// plumbing — but because this module says "use mix", Stackmix compiles each exported
// function into a migratable continuation: it STARTS as a call from the page, and the
// moment it touches api.* it is running on the server, next to the service — the whole
// multi-call workflow in ONE round trip instead of one per api call. Loop state (prices,
// the orders array) lives in the continuation, pinned to neither side.

// Fetch a quote per holding, decide, and place the orders — one hop for the lot.
export function rebalance(holdings, targetWeight) {
  const priced = [];
  let total = 0;
  for (const h of holdings) {
    const px = api.getQuote(h.sym);
    priced.push({ sym: h.sym, qty: h.qty, px, value: h.qty * px });
    total = total + h.qty * px;
  }
  const orders = [];
  for (const p of priced) {
    const drift = p.value / total - targetWeight;
    if (Math.abs(drift) < 0.02) continue;                        // close enough — leave it
    const qty = Math.round(Math.abs(drift) * total / p.px);
    if (qty === 0) continue;
    const o = api.placeOrder({ sym: p.sym, qty, side: drift > 0 ? "sell" : "buy" });
    orders.push(o);
  }
  return { total: Math.round(total), orders, priced };
}

// A single quote — the degenerate one-call action.
export function quote(sym) {
  const px = api.getQuote(sym);
  return Math.round(px * 100) / 100;
}

// Pure helper: runs wherever it's standing (here: in the page, on the result).
export function fmtUsd(n) {
  return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
