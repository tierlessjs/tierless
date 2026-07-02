// An ordinary React app — React owns the rendering, exactly as before Tierless arrived.
// The one new thing: `rebalance` is a mix ACTION (src/actions.mjs). The click calls it
// like a local function; underneath, the continuation runs its api-heavy loop on the
// server through the reference monitor and comes back with the result.
import { useState } from "react";
import { useAction } from "tierless/react";
import { rebalance, quote, fmtUsd } from "./actions.mjs";

const START = [
  { sym: "AAPL", qty: 40 }, { sym: "MSFT", qty: 12 }, { sym: "NVDA", qty: 30 },
  { sym: "AMZN", qty: 25 }, { sym: "GOOG", qty: 28 },
];

export default function App() {
  const [holdings] = useState(START);
  const plan = useAction(rebalance);
  const spot = useAction(quote);

  return (
    <main style={{ font: "15px/1.5 system-ui", maxWidth: 640, margin: "2rem auto" }}>
      <h1>Portfolio — Tierless actions in a React app</h1>
      <p style={{ color: "#666" }}>
        “Rebalance” is one plain function in <code>actions.mjs</code>: a loop of
        <code> api.getQuote</code> calls, a decision, a loop of <code>api.placeOrder</code> calls.
        It runs on the server in <strong>one round trip</strong>, each call authorized by the
        reference-monitor sidecar; this page just awaits the result.
      </p>

      <table cellPadding="4">
        <tbody>
          {holdings.map((h) => (
            <tr key={h.sym}>
              <td><code>{h.sym}</code></td>
              <td align="right">{h.qty} sh</td>
              <td>
                <button onClick={() => spot.run(h.sym)} disabled={spot.running}>quote</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {spot.status === "done" && <p>last quote: <strong>{fmtUsd(spot.result)}</strong></p>}

      <p>
        <button onClick={() => plan.run(holdings, 1 / holdings.length)} disabled={plan.running}>
          {plan.running ? "rebalancing…" : "Rebalance to equal weight"}
        </button>
      </p>

      {plan.status === "error" && <p style={{ color: "#b00" }}>denied or failed: {String(plan.error?.message || plan.error)}</p>}
      {plan.status === "done" && (
        <div>
          <p>portfolio value <strong>{fmtUsd(plan.result.total)}</strong> — {plan.result.orders.length} orders placed:</p>
          <ul>
            {plan.result.orders.map((o, i) => (
              <li key={i}><code>{o.side} {o.qty} {o.sym}</code> <span style={{ color: "#888" }}>by {o.by}</span></li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
