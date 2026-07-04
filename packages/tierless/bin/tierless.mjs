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
//       so `api.getQuote(...)` in a mix module is checked against the real surface.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const TX = fileURLToPath(new URL("../src/transform.cjs", import.meta.url));
// transform.cjs stays CommonJS (own conversion pass — see ROADMAP); require() through
// createRequire is untyped at the call site, so pin it to the real declared signature.
const analyze = require("../src/transform.cjs").analyze;
const [cmd, ...rest] = process.argv.slice(2);
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const usage = `usage:
  tierless build   <in.js> <out.mjs> [--bare] [--head=<file>] [--auto-deref] [--auto-writeback] [--track-writes] [--source-map] [--resource=ns:tier]
  tierless explain <file.js> [--json] [--resource=ns:tier ...]
  tierless api     <service.mjs>
  tierless types   <service.mjs> [out.d.ts]`;
const parseResources = (flags) => {
    const resources = {};
    for (const f of flags)
        if (f.startsWith("--resource=")) {
            const [ns, tier] = f.slice("--resource=".length).split(":");
            if (!ns || !tier)
                die("bad --resource (want ns:tier): " + f);
            resources[ns] = tier;
        }
    return resources;
};
// Find the service definition in a module: the default export or any named export that is
// a defineApi() result ({ create }) or a plain (secret) => Api factory. Arbitrary user code,
// so there is no static shape to check beyond this runtime duck-typing.
async function loadService(file) {
    const mod = await import(pathToFileURL(path.resolve(file)).href);
    const candidates = [mod.default, ...Object.values(mod)];
    const def = candidates.find((v) => v && typeof v.create === "function") || candidates.find((v) => typeof v === "function" && v.length >= 1);
    if (!def)
        die(`tierless: ${file} exports no service — export a defineApi(...) result (or a (secret) => Api factory)`);
    return (typeof def === "function" ? def : def.create)("tierless-cli-inspect");
}
if (cmd === "build") {
    const files = rest.filter((a) => !a.startsWith("--"));
    if (files.length !== 2)
        die(usage);
    try {
        execFileSync(process.execPath, [TX, ...rest], { stdio: "inherit" });
    }
    catch {
        process.exit(1);
    } // transform.cjs already printed the clear message on stderr
}
else if (cmd === "explain") {
    const [file] = rest.filter((a) => !a.startsWith("--"));
    if (!file)
        die(usage);
    let rep; // definite-assignment: die() below never returns, so rep is always set past here
    try {
        rep = analyze(readFileSync(file, "utf8"), { resources: parseResources(rest), filename: file });
    }
    catch (e) {
        die(e.message);
    } // same rejection as build — a clear message, not a V8 stack
    if (rest.includes("--json")) {
        process.stdout.write(JSON.stringify({ file, ...rep }, null, 2) + "\n");
        process.exit(0);
    }
    console.log(`${file} — resources: ${Object.entries(rep.resources).map(([ns, tier]) => `${ns}→${tier}`).join(", ")}\n`);
    for (const f of rep.functions) {
        if (!f.suspendable) {
            console.log(`  ·  ${f.name}${f.exported ? " (exported)" : ""} — pure: runs wherever the continuation stands`);
            continue;
        }
        const why = f.direct
            ? `touches ${[...new Set(f.suspensions.map((s) => s.name))].join(", ")}`
            : `calls suspendable ${f.callsSuspendable.join(", ")}`;
        console.log(`  ✔  ${f.name}${f.exported ? " (exported)" : ""} — compiled to a migratable machine: ${why}`);
        for (const s of f.suspensions)
            console.log(`       line ${s.line}: ${s.name} → ${s.tier} tier`);
    }
    console.log(`\n${rep.functions.filter((f) => f.suspendable).length} compiled, ${rep.functions.filter((f) => !f.suspendable).length} pure.`);
}
else if (cmd === "api") {
    const [file] = rest;
    if (!file)
        die(usage);
    const api = await loadService(file); // an endpoint without authorize throws right here
    const fns = api.fns();
    console.log(`${file} — ${fns.length} endpoints, every one authorized at load time:\n`);
    for (const f of fns)
        console.log(`  ${f.authorize.padEnd(8)} ${f.name}`);
    console.log(`\nOK — the service ships: no endpoint without an explicit authorize.`);
}
else if (cmd === "types") {
    const [file, out] = rest;
    if (!file)
        die(usage);
    const api = await loadService(file);
    const lines = api.fns().map((f) => `  /** authorize: ${f.authorize} */\n  ${f.name}(...args: any[]): any;`);
    const dts = `// GENERATED by \`tierless types ${file}\` — the api surface a mix module calls.\ndeclare const api: {\n${lines.join("\n")}\n};\n`;
    if (out) {
        writeFileSync(out, dts);
        console.log("wrote " + out);
    }
    else
        process.stdout.write(dts);
}
else {
    die(usage, cmd === "--help" || cmd === undefined ? 0 : 2);
}
