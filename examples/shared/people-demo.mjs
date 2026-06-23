// Shared fixture for the people/render demos (examples/spike, examples/two-process).
//
// The program is the hand-lowered IR of this "ordinary TypeScript":
//
//   function render(minAge) {
//     const rows = db.query("people");        // server resource
//     const matched = [];
//     for (const row of rows) {
//       if (row.age >= minAge) matched.push(row.name + " (" + row.age + ")");
//     }
//     DOM.renderList(matched);                 // client resource
//     return matched.length;
//   }
//
// Locals: 0=minAge, 1=rows, 2=matched, 3=i, 4=row
import { createRuntime } from "#stackmix";

const L = { minAge: 0, rows: 1, matched: 2, i: 3, row: 4 };

// Labeled assembly: jump targets are label strings, resolved to indices.
function asm(lines) {
  const labels = {}, code = [];
  for (const l of lines) (typeof l === "string") ? (labels[l] = code.length) : code.push(l.slice());
  for (const ins of code)
    if ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string") ins[1] = labels[ins[1]];
  return code;
}

export const RENDER = {
  nlocals: 5,
  code: asm([
    ["PUSH", "people"],
    ["RES", "db.query", 1],
    ["STORE", L.rows],
    ["NEWARR"],
    ["STORE", L.matched],
    ["PUSH", 0],
    ["STORE", L.i],
    "loop",
    ["LOAD", L.i],
    ["LOAD", L.rows],
    ["GETPROP", "length"],
    ["BIN", "<"],
    ["JMPF", "end"],
    ["LOAD", L.rows],
    ["LOAD", L.i],
    ["INDEX"],
    ["STORE", L.row],
    ["LOAD", L.row],
    ["GETPROP", "age"],
    ["LOAD", L.minAge],
    ["BIN", ">="],
    ["JMPF", "cont"],
    ["LOAD", L.matched],
    ["LOAD", L.row], ["GETPROP", "name"],
    ["PUSH", " ("], ["BIN", "+"],
    ["LOAD", L.row], ["GETPROP", "age"], ["BIN", "+"],
    ["PUSH", ")"], ["BIN", "+"],
    ["ARRPUSH"],
    "cont",
    ["LOAD", L.i], ["PUSH", 1], ["BIN", "+"], ["STORE", L.i],
    ["JMP", "loop"],
    "end",
    ["LOAD", L.matched],
    ["RES", "DOM.renderList", 1],
    ["POP"],
    ["LOAD", L.matched],
    ["GETPROP", "length"],
    ["RET"],
  ]),
};

// A chunky bio field stands in for "the data needed to reconstruct the result is
// large" — the megabytes that should NOT cross when the continuation migrates.
export function makeDataset(n) {
  const people = new Array(n);
  const filler = "x".repeat(100);
  for (let i = 0; i < n; i++) people[i] = { name: "Person " + i, age: i % 100, bio: filler };
  return people;
}

// A runtime with `render` installed. Each process/tier builds its own — there is
// no shared global program anymore.
export function buildRuntime() {
  const rt = createRuntime();
  rt.define("render", RENDER);
  return rt;
}
