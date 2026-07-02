// A tier-fluid continuation whose api.* calls are serviced by the trusted monitor (sidecar), not an
// in-process handler. Plain source — no annotations. api.* pins to the server (backend client), commit
// pins to the browser, so this one function migrates: it authenticates as the session principal, tries
// an admin-only call, then bounces to the browser to render the outcome. The monitor decides each call
// on the verified principal; a denial arrives here as an ordinary throw the try/catch can see — even
// though it was decided in another process, across the tier boundary.
function Flow() {
  const me = api.whoami();                  // server resource → monitor; resolves the verified principal
  let outcome;
  try {
    const del = api.deleteUser("carol");    // admin-only → the monitor authorizes per principal
    outcome = "deleted:" + del.deleted;
  } catch (e) {
    outcome = "denied";                     // a monitor denial is a catchable throw across the tier
  }
  const ev = commit({ who: me.sub, outcome });   // browser resource → the continuation bounces here
  return ev;
}
