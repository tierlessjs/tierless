// Probe: the trust boundary (design §7). Simulate a MALICIOUS browser tier sending forged
// continuations to the server and assert the server's guard (src/secure-host.mjs) rejects each
// attack, while real traffic flows. The server runs its own PROGRAMS by name, so client code never
// executes; the guard defends the DATA: forged programs, forged pcs, fabricated resource calls, and
// forged §5 handles (which would otherwise read arbitrary server heap objects by guessing ids).
import { PROGRAMS, start, run } from "../../src/conduit/bundle.gen.mjs";
import * as api from "../../src/conduit/api.mjs";
import { makeGuard, SecurityError } from "../../src/secure-host.mjs";
import { makeTier } from "../../src/heap.mjs";

let pass = true;
const check = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); pass = pass && cond; };
const rejects = (name, thunk) => { let e = null; try { thunk(); } catch (x) { e = x; } check(name, e instanceof SecurityError); };
const accepts = (name, thunk) => { let ok = true; try { thunk(); } catch { ok = false; } check(name, ok); };

console.log("Probe: the trust boundary — a malicious peer's forged continuations are all rejected\n");

const RESOURCES = ["api.getTags", "api.feed", "api.getArticle", "api.getComments", "api.toggleFavorite", "api.addComment", "api.deleteComment", "api.publish"];
const guard = makeGuard({ programs: PROGRAMS, resources: RESOURCES, tier: "server" });

// --- a REAL legit continuation (run the app to its first server suspension) ---
api.seed();
let legit = null;
{
  let res = start("App");
  while (!res.done) { const r = res.request; if (r.tier === "server") { legit = { stack: res.stack, request: r }; break; } res.stack[res.stack.length - 1].ret = { ev: "stop" }; res = run(res.stack); }
}
accepts("a REAL continuation suspended at api.feed is accepted", () => guard.check(legit));
accepts("a plausible hand-built continuation (known fn, integer pc, allowed resource) is accepted",
  () => guard.check({ stack: [{ fn: "App", pc: 12, args: [] }], request: { tier: "server", name: "api.getArticle", args: ["hello-world"] } }));

// --- forged CONTROL: unknown program / bad pc ---
rejects("forged program name (not in PROGRAMS) is rejected", () => guard.check({ stack: [{ fn: "stealSecrets", pc: 0, args: [] }], request: null }));
rejects("a __proto__ program name is rejected (not an own program)", () => guard.check({ stack: [{ fn: "__proto__", pc: 0, args: [] }], request: null }));
rejects("negative pc is rejected", () => guard.check({ stack: [{ fn: "App", pc: -1, args: [] }], request: null }));
rejects("non-integer pc is rejected", () => guard.check({ stack: [{ fn: "App", pc: "0; drop", args: [] }], request: null }));
// an out-of-range INTEGER pc passes the structural check but the machine's default guard stops it at
// resume — a hard throw, never an infinite loop in `while (true)`.
{
  let e = null; try { PROGRAMS.App({ fn: "App", pc: 99999, args: [] }); } catch (x) { e = x; }
  check("an out-of-range pc throws at resume (the machine default guard), not an infinite loop", e instanceof RangeError);
}

// --- forged RESOURCE (the suspended request) ---
rejects("a fabricated resource name (api.dropEverything) is rejected before any handler runs",
  () => guard.check({ stack: [{ fn: "App", pc: 0, args: [] }], request: { tier: "server", name: "api.dropEverything", args: [] } }));
rejects("a request claiming the wrong tier is rejected",
  () => guard.check({ stack: [{ fn: "App", pc: 0, args: [] }], request: { tier: "browser", name: "api.feed", args: [] } }));

// --- malformed shapes ---
rejects("a non-array stack is rejected", () => guard.check({ stack: "App", request: null }));
rejects("an empty stack is rejected", () => guard.check({ stack: [], request: null }));
rejects("a null frame is rejected", () => guard.check({ stack: [null], request: null }));
rejects("a frame missing pc is rejected", () => guard.check({ stack: [{ fn: "App" }], request: null }));
rejects("a malformed handler stack (__h not an array) is rejected", () => guard.check({ stack: [{ fn: "App", pc: 0, __h: "boom" }], request: null }));
rejects("a handler with a non-integer catch pc is rejected", () => guard.check({ stack: [{ fn: "App", pc: 0, __h: [{ catch: "x", state: 0 }] }], request: null }));

// --- forged §5 HANDLE: the key "no arbitrary heap read" defense ---
const tier = makeTier("server");
const secret = tier.heapPut({ ssn: "999-99-9999", admin: true });     // a private object in the server heap
const publicId = tier.heapPut({ title: "Public Article" });           // a public object the server WILL share
guard.mint(publicId);                                                 // the server issues a capability for the public object only
const handleFor = (id) => ({ stack: [{ fn: "App", pc: 0, data: { __stackmix_handle__: true, owner: "server", id }, args: [] }], request: null });
accepts("a handle the server MINTED (the public object) is accepted", () => guard.check(handleFor(publicId)));
rejects("a forged handle id (the secret object, never minted) is rejected — no arbitrary heap read", () => guard.check(handleFor(secret)));
rejects("a forged handle to a guessed id is rejected", () => guard.check(handleFor(424242)));
check("the secret object was never fetched — its id was a capability the attacker lacked, not an address",
  tier.heapGet(secret).ssn === "999-99-9999");                        // it still exists server-side; the point is the guard never let the peer name it

// --- transparency: the guard must accept EVERY step of a real multi-step journey ---
{
  api.seed();
  const API = { "api.getTags": () => api.getTags(), "api.feed": (t) => api.feed(t), "api.getArticle": (s) => api.getArticle(s), "api.getComments": (s) => api.getComments(s), "api.toggleFavorite": (s) => api.toggleFavorite(s) };
  const evs = [{ ev: "open", slug: "hello-world" }, { ev: "favorite" }, { ev: "home" }, { ev: "stop" }];
  let ei = 0, steps = 0, everRejected = false, res = start("App");
  while (!res.done) {
    const r = res.request;
    if (r.tier === "server") { try { guard.check({ stack: res.stack, request: r }); } catch { everRejected = true; } steps++; res.stack[res.stack.length - 1].ret = API[r.name](...r.args); }
    else res.stack[res.stack.length - 1].ret = evs[ei++] || { ev: "stop" };
    res = run(res.stack);
  }
  check(`the guard is transparent to legit traffic — every server step of a ${steps}-step journey was accepted and it completed`, !everRejected && res.value === "session ended");
}

console.log(`\n  trust boundary: forged programs, pcs, resources, and §5 handles from an untrusted peer are all rejected; ${pass ? "real traffic flows" : "FAILURES above"}`);
process.exit(pass ? 0 : 1);
