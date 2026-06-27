// Overhead microbenchmark inputs.
//   node src/transform.cjs bench/overhead.src.js bench/overhead.gen.mjs --bare
//
// The transform only compiles a function into a state machine if it (transitively) touches
// a tier resource; pure helpers are emitted verbatim and run native. So the state-machine
// tax lands on suspendable ORCHESTRATION, not on hot compute loops — UNLESS a hot loop is
// stuck inside a suspendable function. These three functions isolate that:
//   churnPure  — pure: emitted verbatim, a native loop (zero tax). The fair baseline body.
//   realistic  — suspendable, but the hot loop is factored into churnPure (the common case).
//   worst      — suspendable with the SAME loop inlined, so it compiles to a per-iteration
//                state machine (the worst case for the transform's tax).
function churnPure(n, seed) {
  let acc = seed;
  for (let i = 0; i < n; i = i + 1) {
    acc = (acc * 1103515245 + 12345) & 0x7fffffff;
    if (acc % 7 === 0) acc = acc + i;
  }
  return acc;
}

function realistic(n) {
  const seed = api.seed();            // one resource call -> suspendable; hot loop stays native
  return churnPure(n, seed);
}

function worst(n) {
  const seed = api.seed();            // suspendable; the loop below compiles to a state machine
  let acc = seed;
  for (let i = 0; i < n; i = i + 1) {
    acc = (acc * 1103515245 + 12345) & 0x7fffffff;
    if (acc % 7 === 0) acc = acc + i;
  }
  return acc;
}
