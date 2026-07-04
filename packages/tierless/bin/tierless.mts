#!/usr/bin/env node
// The tierless CLI.
//
//   tierless build <in.js> <out.mjs> [--bare] [--head=<file>] [--auto-deref]
//                  [--auto-writeback] [--track-writes] [--source-map] [--resource=ns:tier]
//       Compile a module to a serializable-state-machine bundle (the transform CLI).
//
//   tierless explain <file.js> [--json] [--resource=ns:tier ...]
//       The suspendability report: which functions compile into migratable machines and
//       WHY (direct resource touches, or calls into suspendable functions), with every
//       suspension point — the compiler's analysis, made visible.
//
//   tierless api <service.mjs>
//       Pre-ship check of a trusted service module (a defineApi/factory export): create
//       it and list the surface — endpoint names and authorization KINDS. An endpoint
//       missing authorize fails HERE, at load time, not in production.
//
//   tierless types <service.mjs> [out.d.ts]
//       Emit a `declare const api` declaration from the service's registered endpoints,
//       so `api.getQuote(...)` in a mix module is checked against the real surface. Each
//       endpoint's parameter list is read from its run signature where statically visible
//       (the `run: ([sym, n]) => …` array destructure IS the caller's signature); endpoints
//       whose run takes the raw args array fall back to (...args: any[]).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type Transform = require("../types/compiler.cjs");
type FunctionReport = ReturnType<(typeof Transform)["analyze"]>["functions"][number];

const require = createRequire(import.meta.url);
const TX = fileURLToPath(new URL("../src/transform.cjs", import.meta.url));
// transform.cjs stays CommonJS (own conversion pass — see ROADMAP); require() through
// createRequire is untyped at the call site, so pin it to the real declared signature.
const analyze = require("../src/transform.cjs").analyze as (typeof Transform)["analyze"];
const [cmd, ...rest] = process.argv.slice(2);

const die = (msg: string, code = 2): never => { console.error(msg); process.exit(code); };
const usage = `usage:
  tierless build   <in.js> <out.mjs> [--bare] [--head=<file>] [--auto-deref] [--auto-writeback] [--track-writes] [--source-map] [--resource=ns:tier]
  tierless explain <file.js> [--json] [--resource=ns:tier ...]
  tierless api     <service.mjs>
  tierless types   <service.mjs> [out.d.ts]`;

const parseResources = (flags: string[]): Record<string, string> => {
  const resources: Record<string, string> = {};
  for (const f of flags) if (f.startsWith("--resource=")) { const [ns, tier] = f.slice("--resource=".length).split(":"); if (!ns || !tier) die("bad --resource (want ns:tier): " + f); resources[ns] = tier; }
  return resources;
};

// Statically read each endpoint's caller-visible signature from the service source: an endpoint's
// run receives the ARGS ARRAY first, so its array-destructure pattern `([to, msg, n = 1, ...tags])`
// names exactly what the mix module passes to api.<name>(...). Collect every `<name>: { run }`
// object-literal property plus every api.fn("<name>", { run }) call; the emitted surface only uses
// entries whose name the RUNTIME also reports (api.fns() stays the source of truth for what exists).
// A run that takes the raw array (`(args) => …`) or a source this parser can't read yields no entry
// — those endpoints keep the (...args: any[]) fallback rather than a guessed signature.
interface EndpointSig { params: string[]; rest: string | null }      // "n?" marks an optional (defaulted) element
function serviceSignatures(src: string): Map<string, EndpointSig> {
  const sigs = new Map<string, EndpointSig>();
  let ast: any;
  try { ast = require("@babel/parser").parse(src, { sourceType: "module", plugins: ["typescript"] }); } catch { return sigs; }
  const sigOf = (fn: any): EndpointSig | null => {
    if (!fn || (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")) return null;
    const p0 = fn.params[0];
    if (!p0) return { params: [], rest: null };                      // run() — the endpoint takes no args
    if (p0.type !== "ArrayPattern") return null;                     // run(args) — arity unknowable statically
    const params: string[] = []; let rest: string | null = null;
    for (const el of p0.elements) {
      if (el && el.type === "Identifier") params.push(el.name);
      else if (el && el.type === "AssignmentPattern" && el.left.type === "Identifier") params.push(el.left.name + "?");
      else if (el && el.type === "RestElement" && el.argument.type === "Identifier") rest = el.argument.name;
      else params.push("arg" + params.length);                       // elision / nested pattern — positional name
    }
    return { params, rest };
  };
  const record = (name: unknown, val: any): void => {
    if (typeof name !== "string" || !val || val.type !== "ObjectExpression") return;
    const run = val.properties.find((p: any) => p.type === "ObjectProperty" && !p.computed && (p.key.name === "run" || p.key.value === "run"));
    const s = run && sigOf(run.value); if (s) sigs.set(name, s);
  };
  (function walk(n: any): void {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "ObjectProperty" && !n.computed && n.value && n.value.type === "ObjectExpression") record(n.key.name ?? n.key.value, n.value);
    if (n.type === "CallExpression" && n.callee?.type === "MemberExpression" && n.callee.property?.name === "fn" && n.arguments?.[0]?.type === "StringLiteral") record(n.arguments[0].value, n.arguments[1]);
    for (const k in n) if (k !== "loc" && k !== "start" && k !== "end" && k !== "leadingComments" && k !== "trailingComments") walk(n[k]);
  })(ast.program);
  return sigs;
}
// A d.ts parameter list from a signature. TS forbids a required param after an optional one
// (JS destructuring doesn't), so once one element is optional the rest are emitted optional too.
function paramList(s: EndpointSig): string {
  const out: string[] = []; let opt = false;
  for (const p of s.params) { opt = opt || p.endsWith("?"); out.push((p.endsWith("?") ? p.slice(0, -1) : p) + (opt ? "?" : "") + ": any"); }
  if (s.rest) out.push(`...${s.rest}: any[]`);
  return out.join(", ");
}

// Find the service definition in a module: the default export or any named export that is
// a defineApi() result ({ create }) or a plain (secret) => Api factory. Arbitrary user code,
// so there is no static shape to check beyond this runtime duck-typing.
async function loadService(file: string) {
  const mod = await import(pathToFileURL(path.resolve(file)).href);
  const candidates = [mod.default, ...Object.values(mod)];
  const def = candidates.find((v: any) => v && typeof v.create === "function") || candidates.find((v: any) => typeof v === "function" && v.length >= 1);
  if (!def) die(`tierless: ${file} exports no service — export a defineApi(...) result (or a (secret) => Api factory)`);
  return (typeof def === "function" ? def : (def as any).create)("tierless-cli-inspect");
}

if (cmd === "build") {
  const files = rest.filter((a) => !a.startsWith("--"));
  if (files.length !== 2) die(usage);
  try { execFileSync(process.execPath, [TX, ...rest], { stdio: "inherit" }); }
  catch { process.exit(1); }                                       // transform.cjs already printed the clear message on stderr
} else if (cmd === "explain") {
  const [file] = rest.filter((a) => !a.startsWith("--"));
  if (!file) die(usage);
  let rep!: ReturnType<typeof analyze>;                             // definite-assignment: die() below never returns, so rep is always set past here
  try { rep = analyze(readFileSync(file, "utf8"), { resources: parseResources(rest), filename: file }); }
  catch (e) { die((e as Error).message); }                         // same rejection as build — a clear message, not a V8 stack
  if (rest.includes("--json")) { process.stdout.write(JSON.stringify({ file, ...rep }, null, 2) + "\n"); process.exit(0); }
  console.log(`${file} — resources: ${Object.entries(rep.resources).map(([ns, tier]) => `${ns}→${tier}`).join(", ")}\n`);
  for (const f of rep.functions as FunctionReport[]) {
    if (!f.suspendable) { console.log(`  ·  ${f.name}${f.exported ? " (exported)" : ""} — pure: runs wherever the continuation stands`); continue; }
    const why = f.direct
      ? `touches ${[...new Set(f.suspensions.map((s) => s.name))].join(", ")}`
      : `calls suspendable ${f.callsSuspendable.join(", ")}`;
    console.log(`  ✔  ${f.name}${f.exported ? " (exported)" : ""} — compiled to a migratable machine: ${why}`);
    for (const s of f.suspensions) console.log(`       line ${s.line}: ${s.name} → ${s.tier} tier`);
  }
  console.log(`\n${rep.functions.filter((f) => f.suspendable).length} compiled, ${rep.functions.filter((f) => !f.suspendable).length} pure.`);
} else if (cmd === "api") {
  const [file] = rest;
  if (!file) die(usage);
  const api = await loadService(file);                            // an endpoint without authorize throws right here
  const fns = api.fns();
  console.log(`${file} — ${fns.length} endpoints, every one authorized at load time:\n`);
  for (const f of fns) console.log(`  ${f.authorize.padEnd(8)} ${f.name}`);
  console.log(`\nOK — the service ships: no endpoint without an explicit authorize.`);
} else if (cmd === "types") {
  const [file, out] = rest;
  if (!file) die(usage);
  const api = await loadService(file);
  const sigs = serviceSignatures(readFileSync(file, "utf8"));
  const lines = api.fns().map((f: { name: string; authorize: string }) => {
    const s = sigs.get(f.name);
    return `  /** authorize: ${f.authorize} */\n  ${f.name}(${s ? paramList(s) : "...args: any[]"}): any;`;
  });
  const dts = `// GENERATED by \`tierless types ${file}\` — the api surface a mix module calls.\ndeclare const api: {\n${lines.join("\n")}\n};\n`;
  if (out) { writeFileSync(out, dts); console.log("wrote " + out); } else process.stdout.write(dts);
} else {
  die(usage, cmd === "--help" || cmd === undefined ? 0 : 2);
}
