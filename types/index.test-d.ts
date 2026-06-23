// Compile-time smoke test for the public type surface. This file is never run;
// `npm run typecheck` asserts that the declarations in ./index.d.ts are internally
// consistent and that a representative use of the API type-checks. If the public
// surface drifts, this stops compiling.

import {
  createRuntime,
  Tier,
  Suspend,
  Miss,
  run,
  serializeContinuation,
  deserializeContinuation,
  initialFrames,
  fmt,
  compileModule,
  type Runtime,
  type Frame,
  type Host,
  type Wire,
  type Program,
} from "./index.js";

// createRuntime() and its methods
const rt: Runtime = createRuntime();
rt.load("function main() { return 1; }", { entry: "main", resources: [] });
rt.loadProgram(new Map([["/a.ts", "export const x = 1;"]]), { entry: "go", entryFile: "/a.ts" });
rt.define("go", { nlocals: 0, code: [["PUSH", 1], ["RET"]] });
const program: Program = rt.program;
const trace = rt.describe([]);
const depth: number = trace.length ? trace[0].depth : 0;
rt.reset();

// tiers, hosts, frames
const server = new Tier("server", { "db.query": (args) => args.length });
const isServer: boolean = server.has("db.query");
const host: Host = { deref: (h) => server.heapGet(h.id) };
const frames: Frame[] = initialFrames("main", [1, "two", true]);

// running + the low-level run()
const r1 = rt.run(server, frames, host);
const r2 = run(program, server, frames, host);
const out: unknown = r1.value ?? r2.value;

// the wire codec
const wire: Wire = serializeContinuation({ frames, pending: null }, server);
const back = deserializeContinuation(wire);

// misc helpers + the compiler entry
const pretty: string = fmt(8_000_000);
const compiled: Program = compileModule("function main() { return 2; }", { entry: "main" });

// reference everything so nothing is reported unused
void [depth, isServer, out, back.frames, pretty, compiled, Suspend, Miss];
