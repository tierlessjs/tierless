// Test262 conformance runner for the AOT (native WASM) path.
//
// Compiles each Test262 test with the Stackmix frontend + aot.mjs, runs it as
// native WASM, and observes the outcome: a passing test runs to completion; a
// conformance failure throws a Test262Error (assert.* in harness262.js). An
// uncaught throw is detected by reading EXC_FLAG out of linear memory after the
// call. The Test262 harness is provided by the Stackmix-compatible shim
// (harness262.js); see that file for the contract and the necessary loosenings.
//
// Stackmix supports a SUBSET of JS, so most of the value is the partition:
//   PASS         compiled, ran, matched the expectation
//   FAIL         compiled and ran, but the WRONG result (a real conformance bug)
//   TRAP         compiled, but the native code trapped at runtime (bug or gap)
//   UNSUPPORTED  the frontend/aot can't compile it (a coverage gap, not a bug)
//   SKIP         out of scope: module/async/raw, or needs an unprovided harness include
// The headline number is PASS / (PASS + FAIL + TRAP) — conformance over the
// supported surface. FAIL and TRAP are the actionable buckets.
//
// Usage:
//   TEST262_ROOT=/path/to/test262 node test/test262/run262.mjs [chapterFilter ...]
// chapterFilter is a substring matched against the path under test/ (default: all
// of language/expressions). Pass --list-fails / --list-traps to dump those buckets.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, EXC_FLAG, EXC_VALUE, readDeep, stdlibHost } from "#stackmix/wasm/aot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TEST262_ROOT || path.join(HERE, "vendor"); // default to the fetched snapshot
if (!fs.existsSync(path.join(ROOT, "test"))) {
  console.error("No test262 corpus found. Fetch the pinned snapshot first:");
  console.error("  node test/test262/fetch262.mjs");
  console.error("(or set TEST262_ROOT to an existing checkout with test/ and harness/).");
  process.exit(2);
}
const SHIM = fs.readFileSync(path.join(HERE, "harness262.js"), "utf8");
const argv = process.argv.slice(2);
const listFails = argv.includes("--list-fails");
const listTraps = argv.includes("--list-traps");
const filters = argv.filter((a) => !a.startsWith("--"));
const CHAPTERS = filters.length ? filters : ["language/expressions"];

// Harness includes we satisfy via the shim; a test that includes anything else is
// out of scope (its harness functions wouldn't be defined).
const PROVIDED_INCLUDES = new Set(["sta.js", "assert.js", "compareArray.js"]);

function parseFrontmatter(src) {
  const m = src.match(/\/\*---([\s\S]*?)---\*\//);
  if (!m) return { flags: [], includes: [], negative: null, features: [] };
  const y = m[1];
  const listField = (name) => {
    const inline = y.match(new RegExp(name + ":\\s*\\[([^\\]]*)\\]"));
    if (inline) return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
    const block = y.match(new RegExp(name + ":\\s*\\n((?:\\s*-\\s*.+\\n?)+)"));
    if (block) return block[1].split("\n").map((l) => (l.match(/-\s*(.+)/) || [])[1]).filter(Boolean).map((s) => s.trim());
    return [];
  };
  const negative = /^\s*negative:/m.test(y)
    ? { phase: (y.match(/phase:\s*(\w+)/) || [])[1], type: (y.match(/type:\s*([\w$]+)/) || [])[1] }
    : null;
  return { flags: listField("flags"), includes: listField("includes"), negative, features: listField("features") };
}

// Rewrite the standard harness call sites onto the shim's standalone functions
// (Stackmix can't method-call a property attached to the `assert` function object).
function adapt(body) {
  return body
    .replace(/\bassert\.sameValue\b/g, "__assertSameValue")
    .replace(/\bassert\.notSameValue\b/g, "__assertNotSameValue")
    .replace(/\bassert\.compareArray\b/g, "__assertCompareArray")
    .replace(/\bassert\.throws\s*\(\s*[\w.$]+\s*,/g, "__assertThrows(") // drop the expected-error type
    .replace(/\bnew\s+Test262Error\s*\(/g, "__t262err(")
    .replace(/\bcompareArray\b(?!\.)/g, "__compareArray");
}

const sh = stdlibHost();
function runOne(testSrc) {
  const fm = parseFrontmatter(testSrc);
  if (fm.flags.includes("module") || fm.flags.includes("raw") || fm.flags.includes("async") || fm.flags.includes("CanBlockIsFalse"))
    return { bucket: "SKIP", why: "flag" };
  if (fm.includes.some((i) => !PROVIDED_INCLUDES.has(i)))
    return { bucket: "SKIP", why: "include:" + fm.includes.find((i) => !PROVIDED_INCLUDES.has(i)) };

  const body = testSrc.replace(/\/\*---[\s\S]*?---\*\//, "");
  const src = SHIM + "\nfunction __t262() {\n" + adapt(body) + "\nreturn 1;\n}";

  let bytes;
  try {
    bytes = compileModuleToWasm(src, { entry: "__t262", resources: [], decode: true });
  } catch (e) {
    if (fm.negative && (fm.negative.phase === "parse" || fm.negative.phase === "resolution"))
      return { bucket: "PASS", why: "neg-compile" }; // expected a static error; Stackmix rejected it (type not checked)
    return { bucket: "UNSUPPORTED", why: (e.message || "").split("\n")[0].slice(0, 90) };
  }
  let inst;
  try {
    inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: sh.imports });
    sh.bind(inst);
    const dv = new DataView(inst.exports.memory.buffer);
    dv.setInt32(BUMP_ADDR, HEAP_BASE, true);
    dv.setInt32(EXC_FLAG, 0, true);
    inst.exports.__t262();
    const threw = dv.getInt32(EXC_FLAG, true) !== 0;
    if (fm.negative) return threw ? { bucket: "PASS", why: "neg-runtime" } : { bucket: "FAIL", why: "expected a throw, completed" };
    if (!threw) return { bucket: "PASS" };
    const keystr = inst.exports.__keystr ? (id) => readDeep(inst.exports.memory, inst.exports.__keystr(id), null) : null;
    const v = readDeep(inst.exports.memory, dv.getInt32(EXC_VALUE, true), keystr);
    return { bucket: "FAIL", why: "threw " + JSON.stringify(v && v.message ? v.message : v).slice(0, 80) };
  } catch (e) {
    // A WebAssembly trap (unreachable / OOB) or instantiate error.
    if (fm.negative) return { bucket: "PASS", why: "neg-trap" };
    return { bucket: "TRAP", why: (e.message || "").split("\n")[0].slice(0, 90) };
  }
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".js") && !e.name.endsWith("_FIXTURE.js")) yield p;
  }
}

const buckets = { PASS: 0, FAIL: 0, TRAP: 0, UNSUPPORTED: 0, SKIP: 0 };
const fails = [], traps = [];
let n = 0;
for (const chap of CHAPTERS) {
  const base = path.join(ROOT, "test", chap);
  if (!fs.existsSync(base)) { console.error("no such chapter:", chap); continue; }
  for (const file of walk(base)) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(path.join(ROOT, "test"), file);
    let r;
    try { r = runOne(src); } catch (e) { r = { bucket: "TRAP", why: "runner:" + (e.message || "").split("\n")[0] }; }
    buckets[r.bucket]++;
    n++;
    if (r.bucket === "FAIL") fails.push(rel + "  —  " + r.why);
    if (r.bucket === "TRAP") traps.push(rel + "  —  " + r.why);
  }
}

const runnable = buckets.PASS + buckets.FAIL + buckets.TRAP;
console.log(`\nTest262 native conformance over ${CHAPTERS.join(", ")}  (${n} files)\n`);
for (const b of ["PASS", "FAIL", "TRAP", "UNSUPPORTED", "SKIP"]) console.log(`  ${b.padEnd(12)} ${buckets[b]}`);
console.log(`\n  conformance (PASS / runnable) = ${buckets.PASS} / ${runnable} = ${runnable ? ((100 * buckets.PASS) / runnable).toFixed(1) : "0"}%`);
if (listFails) { console.log(`\n--- FAIL (${fails.length}) ---`); for (const f of fails.slice(0, 200)) console.log("  " + f); }
if (listTraps) { console.log(`\n--- TRAP (${traps.length}) ---`); for (const t of traps.slice(0, 200)) console.log("  " + t); }
if (!listFails && (fails.length || traps.length)) console.log(`\n  (${fails.length} FAIL, ${traps.length} TRAP — rerun with --list-fails / --list-traps to see them)`);
