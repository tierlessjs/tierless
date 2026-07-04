// Probe: defineApi — the one-call service definition keeps the monitor's guarantees.
// The load-time mandate survives the sugar: an endpoint with no authorize throws at
// create(), before a single call could be served. The build-function form hands the api
// instance to runs that need it (login minting via api.issue), and opts flow through.
import { defineApi, PUBLIC } from "tierless/api";
import { makeCounter } from "../lib/check.mts";

const { check, counts } = makeCounter();

console.log("Probe: defineApi — the sugar keeps the monitor's load-time guarantees\n");

// authorize is still mandatory — at create(), not first-call.
let threw = null;
try { defineApi({ leak: { run: () => 42 } } as any).create("s"); } catch (e: any) { threw = e.message; }  // missing authorize is the point of this test — bypass the static check to reach the runtime guard
check("an endpoint with no authorize cannot ship (throws at create, names the fix)", threw !== null && threw.includes("authorize is required"), threw);

// the build-function form: runs that need the instance (token minting) get it.
const def = defineApi((api) => ({
  login: { authorize: PUBLIC, run: () => api.issue({ sub: "u" }, 60) },
  whoami: { authorize: (p) => p != null, run: (_a, p) => p && p.sub },
}), { maxArgsBytes: 64 });
const api = def.create("secret");

const tok = ((await api.handle({ name: "login" })) as { ok: true; value: string }).value;  // login is PUBLIC and always succeeds — narrow past the ok/error union
check("a build-function run mints a token via the created instance", typeof tok === "string" && tok.includes("."), tok);
const who = await api.handle({ name: "whoami", token: tok });
check("the minted token verifies and authorizes", who.ok === true && who.value === "u", who);
const anon = await api.handle({ name: "whoami" });
check("default-deny still holds through the sugar", anon.ok === false && anon.error === "denied", anon);
const big = await api.handle({ name: "login", args: ["x".repeat(200)], token: null });
check("opts (args budget) flow through defineApi", big.ok === false, big);

const { pass, fail } = counts();
const ok = fail === 0;
console.log(ok
  ? `\nOK — defineApi is sugar, not a bypass: mandatory authorize at create, default-deny, budgets all hold (${pass} checks)`
  : `\nFAILED (${pass} passed, ${fail} failed)`);
process.exit(ok ? 0 : 1);
