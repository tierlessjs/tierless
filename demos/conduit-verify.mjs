// Headless regression for the Conduit app — the larger, framework-shaped sample. It drives the
// auto-compiled continuation (conduit/bundle.gen.mjs) in one process, servicing api.* against the
// real server module and feeding scripted clicks at each dom.commit, and asserts a whole user
// JOURNEY across three views: browse the feed → open an article → favorite it → comment → go back →
// filter by tag → open → back → new article → a blank-title publish that ERRORS (a server-tier throw
// caught across the boundary) → a valid publish that routes to the new article. No browser, no
// socket; this guards the compiler output for a real multi-view app with routing, forms, and
// try/catch over a resource. (demo/live prove the same continuation also migrates over a socket.)
import { run, start, __unwind } from "./conduit/bundle.gen.mjs";
import * as api from "./conduit/api.mjs";
import { textOf } from "./conduit/view.mjs";

api.seed();
const API = {
  "api.getTags": () => api.getTags(), "api.feed": (t) => api.feed(t),
  "api.getArticle": (s) => api.getArticle(s), "api.getComments": (s) => api.getComments(s),
  "api.toggleFavorite": (s) => api.toggleFavorite(s), "api.addComment": (s, b) => api.addComment(s, b),
  "api.deleteComment": (id) => api.deleteComment(id), "api.publish": (t, b, g) => api.publish(t, b, g),
};
const events = [
  { ev: "open", slug: "deep-dive-cps" },        // [1] home -> [2] article
  { ev: "favorite" },                           // [3] re-render: count 7 -> 8
  { ev: "comment", body: "Excellent write-up!" }, // [4] re-render: 2 comments
  { ev: "home" },                               // [5] back to feed
  { ev: "tag", tag: "devops" },                 // [6] filtered feed (only ten-tips)
  { ev: "open", slug: "ten-tips" },             // [7] article
  { ev: "home" },                               // [8] feed
  { ev: "new" },                                // [9] editor
  { ev: "publish", title: "", body: "x", tags: "" },                  // [10] blank title -> error, stay in editor
  { ev: "publish", title: "My First Post", body: "Hello!", tags: "intro me" }, // [11] valid -> new article
  { ev: "stop" },
];

let ei = 0;
const views = [];
let res = start("App");
while (!res.done) {
  const req = res.request;
  if (req.tier === "browser" && req.name === "dom.commit") {
    views.push(textOf(req.args[0]));
    res.stack[res.stack.length - 1].ret = events[ei++] || { ev: "stop" };
  } else if (req.tier === "server") {
    // route a server-tier throw INTO the continuation's try/catch (what runtime.mjs's service does):
    // api.publish("") rejects on the server and the App's try/catch catches it across the boundary.
    try { res.stack[res.stack.length - 1].ret = API[req.name](...req.args); }
    catch (err) { if (!__unwind(res.stack, err)) throw err; }
  } else throw new Error("unknown request " + JSON.stringify(req));
  res = run(res.stack);
}

views.forEach((v, i) => console.log(`  [${i + 1}] ${v.slice(0, 96)}`));
const has = (i, s) => views[i] && views[i].includes(s);
const ok = res.value === "session ended" && views.length === 11 &&
  has(0, "conduit") && has(0, "A Deep Dive into CPS") && has(0, "Ten Tips") &&     // [1] feed, fav-sorted
  has(1, "A Deep Dive into CPS") && has(1, "♡ 7") && has(1, "Mind blown") && has(1, "1 comments") && // [2] article
  has(2, "♥ 8") &&                                                                // [3] favorited: count up + filled heart
  has(3, "2 comments") && has(3, "Excellent write-up!") &&                        // [4] comment posted
  has(4, "conduit") && has(4, "Ten Tips") &&                                      // [5] back at the feed
  has(5, "Ten Tips") && !has(5, "A Deep Dive") &&                                 // [6] tag filter excludes others
  has(6, "Ten Tips for Faster Builds") &&                                         // [7] opened that article
  has(8, "New Article") &&                                                        // [9] editor
  has(9, "title can't be blank") && has(9, "New Article") &&                      // [10] server throw caught -> error banner, still editor
  has(10, "My First Post") && has(10, "0 comments");                             // [11] published -> new article page
console.log("\n=> " + res.value);
console.log(ok
  ? "PASS — the multi-view Conduit app (routing, forms, favorite, try/catch over a resource) runs correctly as one compiled continuation"
  : "FAIL");
process.exit(ok ? 0 : 1);
