#!/usr/bin/env node
// Stackmix CLI. Thin, dependency-free wrapper over the public API (#stackmix):
//
//   stackmix compile <file.ts> [--entry main] [--out program.json]
//   stackmix run     <file.ts> [--entry main]
//   stackmix new     <dir>
//   stackmix --help | --version
//
// `compile` lowers TypeScript to Stackmix IR; `run` compiles and executes a
// resource-free program (the boundary-free case) and prints its result; `new`
// scaffolds a starter project.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, basename, dirname, join } from "node:path";
import { createRuntime, Tier, initialFrames, Suspend } from "#stackmix";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const HELP = `stackmix ${pkg.version} — tierless continuation migration

Usage:
  stackmix compile <file.ts> [--entry <name>] [--out <file.json>]
      Compile a TypeScript module to Stackmix IR. Prints a summary; with --out,
      writes the program (name -> { nlocals, code }) as JSON.

  stackmix run <file.ts> [--entry <name>]
      Compile and run a resource-free program, printing the return value. (A
      program that touches a resource suspends to migrate; wire up tiers with
      the API to run those — see examples/.)

  stackmix new <dir>
      Scaffold a starter Stackmix project in <dir>.

Options:
  --entry <name>        Entry function (default: main)
  --resources <a,b,c>   Comma-separated resource names; calls to these lower to
                        migration boundaries (e.g. db.query,ui.render)
  --out <file>          Output path for 'compile' (default: stdout summary only)
  -h, --help       Show this help
  -v, --version    Show version

Docs: ${pkg.homepage}`;

function parse(argv) {
  const args = { _: [], entry: "main", out: null, resources: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--entry") args.entry = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--resources") args.resources = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else args._.push(a);
  }
  return args;
}

function readSource(file) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) fail(`no such file: ${file}`);
  return { path, source: readFileSync(path, "utf8") };
}

function fail(msg) {
  console.error(`stackmix: ${msg}`);
  process.exit(1);
}

function compile(args) {
  const file = args._[1];
  if (!file) fail("compile: expected a <file.ts>");
  const { path, source } = readSource(file);
  const rt = createRuntime();
  let program;
  try {
    program = rt.load(source, { entry: args.entry, resources: args.resources, file: path });
  } catch (e) {
    fail(`compile failed: ${e && e.message ? e.message : e}`);
  }
  const fns = Object.keys(program);
  const instrs = Object.values(program).reduce((s, f) => s + f.code.length, 0);
  if (args.out) {
    const outPath = resolve(process.cwd(), args.out);
    writeFileSync(outPath, JSON.stringify(program, null, 2) + "\n");
    console.log(`Wrote ${args.out} — ${fns.length} function(s), ${instrs} IR instruction(s).`);
  } else {
    console.log(`Compiled ${basename(file)} -> ${fns.length} function(s), ${instrs} IR instruction(s):`);
    for (const name of fns) console.log(`  ${name}  (${program[name].code.length} instr, ${program[name].nlocals} locals)`);
    console.log(`\nPass --out <file.json> to emit the program.`);
  }
}

function run(args) {
  const file = args._[1];
  if (!file) fail("run: expected a <file.ts>");
  const { path, source } = readSource(file);
  const rt = createRuntime();
  try {
    rt.load(source, { entry: args.entry, resources: args.resources, file: path });
  } catch (e) {
    fail(`compile failed: ${e && e.message ? e.message : e}`);
  }
  const tier = new Tier("cli", {});
  const host = { deref: (x) => x };
  try {
    const result = rt.run(tier, initialFrames(args.entry, []), host);
    console.log(typeof result.value === "object" ? JSON.stringify(result.value, null, 2) : String(result.value));
  } catch (e) {
    if (e instanceof Suspend && e.pending && e.pending.name) {
      fail(`'${args.entry}' suspended at resource '${e.pending.name}'. ` +
        `stackmix run executes resource-free programs; provide tiers via the API to migrate across boundaries.`);
    }
    fail(`run failed: ${e && e.message ? e.message : e}`);
  }
}

function scaffold(args) {
  const dir = args._[1];
  if (!dir) fail("new: expected a target <dir>");
  const dest = resolve(process.cwd(), dir);
  if (existsSync(dest)) fail(`refusing to overwrite existing path: ${dir}`);
  const template = join(HERE, "..", "templates", "basic");
  mkdirSync(dest, { recursive: true });
  cpSync(template, dest, { recursive: true });
  // Personalize the scaffold's package name.
  const pkgPath = join(dest, "package.json");
  const appPkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  appPkg.name = basename(dest);
  writeFileSync(pkgPath, JSON.stringify(appPkg, null, 2) + "\n");
  console.log(`Created ${dir}/\n\n  cd ${dir}\n  npm install\n  npm start\n`);
}

const args = parse(process.argv.slice(2));
if (args.version) { console.log(pkg.version); process.exit(0); }
if (args.help || args._.length === 0) { console.log(HELP); process.exit(0); }

switch (args._[0]) {
  case "compile": compile(args); break;
  case "run": run(args); break;
  case "new": case "create": scaffold(args); break;
  default: fail(`unknown command '${args._[0]}' (try: stackmix --help)`);
}
