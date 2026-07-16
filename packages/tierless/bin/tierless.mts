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
//   tierless gateway --backend <url> [--port 8180] [--host 127.0.0.1] [--allow-origin o1,o2]
//                    [--cookie-authority] [--preboot /path ...] [--wire-truth]
//       The corpus-port session gateway in a box (docs/corpus.md rung 2/3) — what each
//       port used to carry as its own gateway.mts: a thin exec gateway colocated with
//       the backend. Same-origin crossings execute against --backend over localhost;
//       --cookie-authority turns on sealed cookie mediation (reseal/claim endpoints,
//       hello blob in the upgrade); --wire-truth serves TCP-true byte counters at
//       /__tierless/wire for the measurement reporter.
//
//   tierless types <service.mjs> [out.d.ts]
//       Emit a `declare const api` declaration from the service's registered endpoints,
//       so `api.getQuote(...)` in a mix module is checked against the real surface. Each
//       endpoint's parameter list is read from its run signature where statically visible
//       (the `run: ([sym, n]) => …` array destructure IS the caller's signature); endpoints
//       whose run takes the raw args array fall back to (...args: any[]). Return types are
//       inferred by the TypeScript checker over each run body (Promise-unwrapped — the
//       monitor awaits run's result) and kept only when self-contained in a standalone
//       d.ts; typescript resolves from the consumer's project (it's who checks the output).
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
  tierless gateway --backend <url> [--port 8180] [--host 127.0.0.1] [--allow-origin o1,o2] [--cookie-authority] [--preboot /path ...] [--wire-truth]
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

// typescript is not a dependency of tierless — it resolves from the project running the CLI,
// which is whoever consumes the emitted d.ts. Without it the surface keeps `any` returns.
let tsMod: any | null | undefined;                                  // undefined = not tried, null = unavailable
function loadTS(): any | null {
  if (tsMod !== undefined) return tsMod;
  try { tsMod = require("typescript"); }
  catch { tsMod = null; console.error("tierless: typescript not found — return types emitted as any (npm i -D typescript to infer them)"); }
  return tsMod;
}

// Infer each endpoint's RETURN type with the TypeScript checker over the run body — this is what
// a parse can't do (roadmap: "needs a type checker over the service body"). The monitor awaits
// run's result before answering (api.mts _call), so a Promise-returning run unwraps to the value
// the mix-module caller actually receives; literal types widen the way tsc's own declaration
// emit would. `any` results are dropped so the fallback stays a single spelling.
function serviceReturnTypes(abs: string): Map<string, string> {
  const rets = new Map<string, string>();
  const ts = loadTS();
  if (!ts) return rets;
  const program = ts.createProgram([abs], { allowJs: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const sf = program.getSourceFile(abs);
  if (!sf) return rets;
  const checker = program.getTypeChecker();
  const record = (name: unknown, obj: any): void => {
    if (typeof name !== "string" || !obj || !ts.isObjectLiteralExpression(obj)) return;
    const run = obj.properties.find((p: any) => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && p.name.text === "run");
    const fn = run && run.initializer;
    if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) return;
    const sig = checker.getSignatureFromDeclaration(fn);
    if (!sig) return;
    const ret = sig.getReturnType();
    const t = checker.getWidenedType(checker.getAwaitedType(ret) ?? ret);
    const text = checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation).replace(/\s+/g, " ");
    if (text !== "any") rets.set(name, text);
  };
  (function walk(n: any): void {
    if (ts.isPropertyAssignment(n) && !ts.isComputedPropertyName(n.name) && ts.isObjectLiteralExpression(n.initializer)) record(n.name.text, n.initializer);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "fn" && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) record(n.arguments[0].text, n.arguments[1]);
    ts.forEachChild(n, walk);
  })(sf);
  return rets;
}

// The emitted d.ts is STANDALONE (`declare const api`), so an inferred return type may only use
// globals — a type naming a service-local class or an unresolvable import would break the
// consumer's typecheck, which is worse than `any`. Check the assembled declaration with the same
// compiler that will consume it; each endpoint is exactly two lines (doc comment + signature), so
// a diagnostic's line maps straight back to the endpoint to downgrade.
function invalidReturnTypes(dts: string, fns: { name: string }[]): string[] {
  const ts = loadTS();
  if (!ts) return [];
  const name = "tierless-api-check.d.ts";
  const sf = ts.createSourceFile(name, dts, ts.ScriptTarget.ES2022, true);
  const opts = { noEmit: true };
  const host = ts.createCompilerHost(opts);
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (f: string, ...a: any[]) => (f === name ? sf : orig(f, ...a));
  const program = ts.createProgram([name], opts, host);
  const bad = new Set<string>();
  for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
    if (d.start == null) continue;
    const line = sf.getLineAndCharacterOfPosition(d.start).line;    // 0: GENERATED, 1: declare, then 2 lines per endpoint
    const f = fns[Math.floor((line - 2) / 2)];
    if (f) bad.add(f.name);
  }
  return [...bad];
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
} else if (cmd === "gateway") {
  // The port gateway in a box — replaces the per-port gateway.mts files (they were four
  // flags' worth of differences). Deployment posture unchanged: browser↔gateway is the
  // one real-latency hop, gateway↔backend is localhost.
  const flag = (name: string): string | undefined => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const multi = (name: string): string[] => rest.flatMap((a, i) => (a === name && rest[i + 1] ? [rest[i + 1]] : []));
  const backend = flag("--backend") || process.env.TIERLESS_API_URL || (die(usage) as never);
  const port = Number(flag("--port") || process.env.TIERLESS_GATEWAY_PORT || 8180);
  const host = flag("--host") || "127.0.0.1";                       // loopback by default: an unauthenticated exec bridge to the backend must not bind wide
  const origins = (flag("--allow-origin") || process.env.TIERLESS_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const prebootPaths = multi("--preboot");
  const { createServer } = await import("node:http");
  // package self-reference: the bin's tsconfig compiles only bin/, so src modules are
  // reached the way any consumer reaches them — through the exports map
  const { attachTierless, makeWireStats } = await import("tierless/server");
  const { restResources } = await import("tierless/adapt");
  const wire = rest.includes("--wire-truth") || process.env.TIERLESS_WIRE_TRUTH ? makeWireStats() : undefined;
  // sealed cookie authority (session-auth.mts): crossings carry a sealed jar blob, the
  // gateway rotates in-band on mediated Set-Cookie and stores no credentials. Its
  // reseal/claim endpoints trade credentials, so --cookie-authority REQUIRES the origin
  // gate. Without it, hello declares sealed:false (attachTierless's default) and
  // adapt-auto's auth:"auto" no-ops.
  const authority = rest.includes("--cookie-authority")
    ? (await import("tierless/session-auth")).cookieAuthority({ backendUrl: backend, allowedOrigins: origins.length ? origins : (die("tierless gateway: --cookie-authority requires --allow-origin (reseal/claim trade credentials)") as never), prebootPaths })
    : undefined;
  const server = createServer((req, res) => {
    if (wire && req.url === "/__tierless/wire") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(wire.read())); return; }
    if (authority?.handleHttp(req, res)) return;
    res.statusCode = 200; res.end("tierless gateway");              // the suite's boot readiness wait
  });
  const exec = authority ? authority.exec : restResources(backend, { envelopeErrors: true });
  attachTierless(server, {
    // exec-only: no compiled machines (the adapter path crosses per request); compiled
    // surfaces resolve from a manifest when a port lands them
    bundle: { PROGRAMS: {}, __unwind: () => false } as never,
    wire,
    session: async (req) => {
      // websockets don't do CORS: loopback binding alone doesn't stop a hostile page the
      // developer happens to visit from reaching the backend through this exec bridge
      const origin = String(req.headers.origin || "");
      if (origins.length && !origins.includes(origin)) throw new Error("tierless gateway: origin not allowed: " + JSON.stringify(origin));
      return authority ? { exec, hello: await authority.hello(String(req.headers.cookie || "")) } : { exec };
    },
  });
  // print the BOUND port (--port 0 lets a harness pick a free one and parse it back)
  server.listen(port, host, () => console.log(`tierless gateway ${host}:${(server.address() as { port: number }).port} -> ${backend}${authority ? " (cookie authority)" : ""}${wire ? " (wire truth)" : ""}`));
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
  const fns: { name: string; authorize: string }[] = api.fns();
  const rets = serviceReturnTypes(path.resolve(file));
  const assemble = (): string => {
    const lines = fns.map((f) => {
      const s = sigs.get(f.name);
      return `  /** authorize: ${f.authorize} */\n  ${f.name}(${s ? paramList(s) : "...args: any[]"}): ${rets.get(f.name) || "any"};`;
    });
    return `// GENERATED by \`tierless types ${file}\` — the api surface a mix module calls.\ndeclare const api: {\n${lines.join("\n")}\n};\n`;
  };
  for (const name of invalidReturnTypes(assemble(), fns)) rets.delete(name);   // a type the standalone d.ts can't express -> honest any
  const dts = assemble();
  if (out) { writeFileSync(out, dts); console.log("wrote " + out); } else process.stdout.write(dts);
} else {
  die(usage, cmd === "--help" || cmd === undefined ? 0 : 2);
}
