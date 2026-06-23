// Shared program for the cross-process fetch demo. Both processes import this so
// they run the identical module (resume is by instruction offset).
//
//   function profileView(id) {
//     const p = db.profile(id);     // server resource -> a big profile object
//     render(p.name);               // client resource: reads p.name on the server,
//                                   //   then migrates to the client (p becomes a handle)
//     return p.bio.length;          // on the client: deref p (remote handle) -> FETCH
//   }
// locals: 0 id, 1 p
import { PROGRAM } from "./stackmix-core.mjs";

PROGRAM.profileView = {
  nlocals: 2,
  code: [
    ["LOAD", 0], ["RES", "db.profile", 1], ["STORE", 1],
    ["LOAD", 1], ["GETPROP", "name"], ["RES", "render", 1], ["POP"],
    ["LOAD", 1], ["GETPROP", "bio"], ["GETPROP", "length"], ["RET"],
  ],
};
