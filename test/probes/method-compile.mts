// PROBE: class methods as compilation units — the real-code seam (ports/vikunja/COMPILING.md).
// A class shaped like Vikunja's AbstractService (async method, await this.http.get, try/
// finally, instance mutations, an arrow using `this`, param defaults) compiles into a
// PROGRAM; the machine parks at the instance-held resource; the kept class's stub falls
// back to the untouched original when no method host is bound, and routes to the binding
// when one is — with both paths producing identical results.
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { compile } = require("../../packages/tierless/src/transform.cjs");

let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "ok" : "FAIL"}  ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

const SRC = `"use tierless";
export class Svc {
  constructor(http) { this.http = http; this.paths = { getAll: "/things" }; this.totalPages = 0; this.done = false; }
  tag(x) { return { ...x, tagged: true }; }
  async getAll(params = {}) {
    params.page = params.page || 1;
    try {
      const response = await this.http.get(this.paths.getAll, { params });
      this.totalPages = Number(response.headers["x-total"]);
      return response.body.map((e) => this.tag(e));
    } finally {
      this.done = true;
    }
  }
  plain() { return 7; }
}`;

const { code, meta } = compile(SRC, { resources: { "this.http": "server" }, filename: "svc.js" });

check("meta.methods records the compiled method", meta.methods.length === 1 && meta.methods[0].program === "Svc$getAll" && !meta.methods[0].error, JSON.stringify(meta.methods));
check("program listed", meta.programs.includes("Svc$getAll"));
check("plain method untouched (no stub, no program)", !code.includes("__tierless_orig_plain") && !meta.programs.includes("Svc$plain"));

const dir = mkdtempSync(join(tmpdir(), "tlm-"));
writeFileSync(join(dir, "svc.mjs"), code);
const mod = await import(pathToFileURL(join(dir, "svc.mjs")).href);

const ENVELOPE = { status: 200, headers: { "x-total": "3" }, body: [{ id: 1 }, { id: 2 }] };

// ---- machine path: drive the PROGRAM directly, assert the parked request ---------------
const seen: Array<{ name: string; args: unknown[] }> = [];
const drive = (entry: string, args: unknown[]): unknown => {
  const stack: Array<Record<string, unknown>> = [{ fn: entry, pc: 0, args }];
  for (let i = 0; i < 10_000; i++) {
    const r = mod.PROGRAMS[(stack[stack.length - 1] as { fn: string }).fn](stack[stack.length - 1]);
    if (r.op === "return") { stack.pop(); if (!stack.length) return r.value; (stack[stack.length - 1] as { ret?: unknown }).ret = r.value; }
    else if (r.op === "call") stack.push({ fn: r.fn, pc: 0, args: r.args });
    else if (r.op === "throw") throw r.value;
    else { seen.push({ name: r.name, args: r.args }); (stack[stack.length - 1] as { ret?: unknown }).ret = ENVELOPE; }
  }
  throw new Error("did not terminate");
};

const inst1 = { paths: { getAll: "/things" }, totalPages: 0, done: false, tag: (x: Record<string, unknown>) => ({ ...x, tagged: true }) };
const out1 = drive("Svc$getAll", [inst1, { page: 0 }]) as Array<{ tagged: boolean }>;
check("machine parks at http.get with receiver dropped", seen.length === 1 && seen[0].name === "http.get" && seen[0].args[0] === "/things");
check("param default + mutation visible in request args", JSON.stringify(seen[0].args[1]) === '{"params":{"page":1}}', JSON.stringify(seen[0].args[1]));
check("arrow using `this` maps through __self", out1.length === 2 && out1.every((x) => x.tagged));
check("instance mutations landed (incl. finally)", inst1.totalPages === 3 && inst1.done === true);

// ---- stub path, unbound: the original method runs (stock behavior) ---------------------
const fakeHttp = { get: async (url: string, cfg: unknown) => { seen.push({ name: "orig:" + url, args: [cfg] }); return ENVELOPE; } };
const inst2 = new mod.Svc(fakeHttp);
const out2 = await inst2.getAll();
check("unbound stub runs the kept original (await path intact)", out2.length === 2 && out2[0].tagged && inst2.totalPages === 3 && inst2.done === true);
check("original really used this.http", seen.some((s) => s.name === "orig:/things"));

// ---- stub path, bound: routes to the method host with (program, this, args) -------------
let routed: { prog: string; self: unknown; args: unknown[] } | null = null;
mod.__bindTierlessMethods((prog: string, self: unknown, args: unknown[]) => {
  routed = { prog, self, args };
  return Promise.resolve(drive(prog, [self, ...args]));
});
const inst3 = new mod.Svc(fakeHttp);
const out3 = await inst3.getAll({ page: 5 });
const got = routed as { prog: string; self: unknown; args: unknown[] } | null;   // TS can't see the callback assignment above
check("bound stub routes (program, this, args)", got !== null && got.prog === "Svc$getAll" && got.self === inst3 && JSON.stringify(got.args) === '[{"page":5}]');
check("bound path result matches original semantics", out3.length === 2 && out3[1].tagged && inst3.totalPages === 3);

// ---- a NESTED closure's local stays its own const — never a frame slot ------------------
// vikunja's getBlobUrl shape: after the tier call, the return value is built inside a
// Promise executor with its own `const reader`. The old declaration rewrite hoisted that
// declaration to `F.reader = …` while the scope-checked identifier pass (correctly) left
// its READS bare — every SVG blob crashed with "reader is not defined". The nested local
// must survive intact, and must NOT clobber a same-named frame local.
{
  const { code: codeN, meta: metaN } = compile(`"use tierless";
export class N {
  async m(u) {
    const label = "L";
    const response = await this.http.get(u);
    return new Promise((res) => { const label = response.body + ":" + "inner"; res(label); }).then((x) => x + ":" + label);
  }
}`, { resources: { "this.http": "server" }, filename: "n.js" });
  check("nested-local method compiles", metaN.methods[0]?.program === "N$m", JSON.stringify(metaN.methods));
  const dirN = mkdtempSync(join(tmpdir(), "tln-"));
  writeFileSync(join(dirN, "n.mjs"), codeN);
  const modN = await import(pathToFileURL(join(dirN, "n.mjs")).href);
  const stackN: Array<Record<string, unknown>> = [{ fn: "N$m", pc: 0, args: [{}, "/u"] }];
  let outN: unknown;
  for (let i = 0; i < 100; i++) {
    const r = modN.PROGRAMS[(stackN[stackN.length - 1] as { fn: string }).fn](stackN[stackN.length - 1]);
    if (r.op === "return") { outN = r.value; break; }
    (stackN[stackN.length - 1] as { ret?: unknown }).ret = { status: 200, headers: {}, body: "B" };
  }
  check("nested executor local resolves (no bare read of a hoisted name, no frame clobber)", await outN === "B:inner:L", String(await outN));
}

// ---- awaited member calls compile into dynamic parks; only bare awaits reject ------------
const { meta: meta2 } = compile(`"use tierless";
export class W { async m() { await Promise.resolve(1); const r = this.http.get("/x"); return r; } }`,
{ resources: { "this.http": "server" }, filename: "w.js" });
check("awaited member call compiles (a dynamic park now, not a rejection)", meta2.methods.length === 1 && meta2.methods[0].program === "W$m", JSON.stringify(meta2.methods));

const { meta: metaBare } = compile(`"use tierless";
export class V { async m(p) { await p; const r = this.http.get("/x"); return r; } }`,
{ resources: { "this.http": "server" }, filename: "v.js" });
check("a BARE await (no call to dispatch on) still rejects with the reason", metaBare.methods.length === 1 && metaBare.methods[0].program === null && /awaits a non-resource/.test(metaBare.methods[0].error || ""), JSON.stringify(metaBare.methods));

// ---- super use stays uncompiled with a reason -------------------------------------------
const { meta: meta3 } = compile(`"use tierless";
class B { async m() { return 1; } }
export class S extends B { async m() { const r = this.http.get("/x"); return super.m() + r; } }`,
{ resources: { "this.http": "server" }, filename: "s.js" });
const sEntry = meta3.methods.find((x: { class: string }) => x.class === "S");
check("super reported, method kept original", !!sEntry && sEntry.program === null && /super/.test(sEntry.error || ""), JSON.stringify(meta3.methods));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nclass methods compile, park, and fall back correctly");
