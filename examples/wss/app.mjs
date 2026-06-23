// Shared program for the WSS migration + fetch demo. The browser and the server
// build the identical module, so resume-by-instruction-offset lines up on both
// sides. This is the hand-lowered IR of:
//
//   function profileView(id) {
//     const p = db.profile(id);   // server resource -> a big profile object
//     render(p.name);             // client resource: the server reads p.name, then
//                                 //   migrates to the browser to render (p stays a handle)
//     return p.bio.length;        // back on the browser: deref p (remote handle) -> FETCH
//   }
//   locals: 0 id, 1 p
import { createRuntime } from "#stackmix";

// bio is > HANDLE_THRESHOLD (64 KB), so the profile migrates back as a §5 handle
// and the bytes cross only if/when the browser actually dereferences it.
export const BIO = 120_000;

export function buildRuntime() {
  const rt = createRuntime();
  rt.define("profileView", {
    nlocals: 2,
    code: [
      ["LOAD", 0], ["RES", "db.profile", 1], ["STORE", 1],
      ["LOAD", 1], ["GETPROP", "name"], ["RES", "render", 1], ["POP"],
      ["LOAD", 1], ["GETPROP", "bio"], ["GETPROP", "length"], ["RET"],
    ],
  });
  return rt;
}
