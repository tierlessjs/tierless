// Tierless ⨯ React — call a mix action from a component with run-state for the UI.
//
//   import { useAction } from "tierless/react";
//   import { rebalance } from "./actions.mjs";        // a "use tierless" module
//
//   const { run, running, result, error } = useAction(rebalance);
//   <button onClick={() => run(portfolio)} disabled={running}>Rebalance</button>
//
// The action itself is just an async-looking call — the continuation may hop tiers any
// number of times underneath — so this hook is nothing but promise plumbing with status.
// React is a peer dependency; this module is only loaded via `tierless/react`.
import { useCallback, useRef, useState } from "react";
export function useAction(action) {
    const [state, set] = useState({ status: "idle", result: undefined, error: undefined });
    const seq = useRef(0); // ignore out-of-order settles
    const run = useCallback(async (...args) => {
        const mine = ++seq.current;
        set({ status: "running", result: undefined, error: undefined });
        try {
            const result = await action(...args);
            if (seq.current === mine)
                set({ status: "done", result, error: undefined });
            return result;
        }
        catch (error) {
            if (seq.current === mine)
                set({ status: "error", result: undefined, error });
            throw error;
        }
    }, [action]);
    return { run, status: state.status, running: state.status === "running", result: state.result, error: state.error };
}
