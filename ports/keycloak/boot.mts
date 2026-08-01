// Boot one Keycloak arm: the RELEASE distribution (26.7.0) with this arm's admin-ui
// build injected into org.keycloak.keycloak-admin-ui-26.7.0.jar, plus the session
// gateway on :8180 (page port + 100).
//
// Why a release distribution and not a Maven build of the server: the port touches only
// the admin console's JavaScript, which Keycloak serves out of one jar as a theme
// (theme/keycloak.v2/admin/resources — exactly what admin-ui's vite.config.ts writes).
// Injecting that directory is the whole difference between the arms; the Java server is
// byte-identical in both, which is a stronger control than rebuilding it twice would be.
//
// Exports bootKeycloak(); run directly to boot and hold.
//
//   node ports/keycloak/boot.mts [--baseline]
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, openSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VARIANT = process.argv.includes("--baseline") ? "keycloak-baseline" : "keycloak";
const WORK = fileURLToPath(new URL(`../work/${VARIANT}/`, import.meta.url));
const KC = path.join(WORK, "kc/");
export const FRONT = "http://localhost:8080";      // Keycloak serves the console AND the admin API on one origin
export const GATEWAY = "http://localhost:8180";

/** The feature set their Admin UI E2E job starts the server with, verbatim
 *  (.github/workflows/js-ci.yml, job `admin-ui-e2e`, at the pinned 26.7.0 tree).
 *
 *  Not optional decoration: 11 of the suite's 68 specs exercise UI that only exists when
 *  the matching feature is on — 4 oid4vci (client-scope, mappers, client assignment, realm
 *  attributes), 2 workflows, 2 permissions (admin-fine-grained-authz:v2), and one each for
 *  spiffe, kubernetes-service-accounts and jwt-authorization-grant. Booting bare fails them
 *  on BOTH arms, which measures nothing and costs a suite run to discover.
 *
 *  setup.sh reads this constant for its snapshot boot, so the pristine database and every
 *  measured arm agree on the schema these features create. */
export const FEATURES = "admin-fine-grained-authz:v2,transient-users,spiffe,oid4vc-vci,kubernetes-service-accounts,jwt-authorization-grant,workflows";

const serving = (url: string): Promise<boolean> => fetch(url).then(() => true, () => false);
async function waitFor(url: string, ms: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + url);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Restore this arm's H2 database to the state the first boot left (bootstrap admin user,
 *  stock master realm). The suite creates realms, clients, users and groups and deletes
 *  only some of them; grafana taught this the expensive way, scoring the SAME arm 97 clean
 *  and 82 dirty. Both variants reset identically, so every arm starts from the same rows. */
function resetData(): void {
  const pristine = path.join(WORK, "kc-pristine-data/");
  if (!existsSync(pristine)) throw new Error(`no pristine snapshot in ${pristine} — run ports/keycloak/setup.sh first`);
  rmSync(path.join(KC, "data"), { recursive: true, force: true });
  cpSync(pristine, path.join(KC, "data"), { recursive: true });
}

/** `frontend` is the origin the BROWSER reaches this arm through — plain `FRONT` for an
 *  unshaped run, the relay (`:28080` truth, `:18080` RTT) when one is in front. It is
 *  passed to `--hostname`, and that is load-bearing rather than cosmetic:
 *
 *  Keycloak derives a realm's OIDC issuer from the request's Host unless told otherwise,
 *  and it validates bearer tokens against that issuer. The ported arm is the only arm
 *  whose traffic reaches the server by TWO hosts — the browser logs in through the relay,
 *  while admin-API crossings ride the session and arrive from the gateway on :8080 — so a
 *  token minted with `iss` of the relay host was rejected 401 on the backend host. It cost
 *  the whole suite: the console rendered "HTTP 401 Unauthorized" and every spec timed out
 *  waiting for a page that never loaded, while the baseline arm (one host throughout) and
 *  the unshaped ported arm (page and backend both :8080) passed and hid it.
 *
 *  Pinning the frontend URL makes the issuer constant no matter which port a request
 *  arrives on, so one token is valid on both. Measured on 26.7.0: unpinned, a :28080 token
 *  is 401 on :8080; pinned, every token is 200 on both. */
export async function bootKeycloak(opts: { frontend?: string } = {}): Promise<{ close(): void }> {
  const frontend = opts.frontend ?? FRONT;
  if (!existsSync(path.join(KC, "bin/kc.sh"))) throw new Error("no distribution in " + KC + " — run ports/keycloak/setup.sh first");
  for (const url of [FRONT, GATEWAY]) {
    if (await serving(url)) throw new Error(`${url} is already serving — a stale stack owns the port; kill it before booting`);
  }
  resetData();
  const log = (name: string): ["ignore", number, number] => { const fd = openSync(path.join(WORK, name + ".log"), "w"); return ["ignore", fd, fd]; };
  const procs: ChildProcess[] = [
    spawn(path.join(KC, "bin/kc.sh"), ["start-dev", "--http-port=8080", `--features=${FEATURES}`, `--hostname=${frontend}`], {
      cwd: KC,
      // start-dev is what their own e2e lane runs; the bootstrap admin is the
      // admin/admin the suite's test/utils/constants.ts expects.
      env: { ...process.env, KC_BOOTSTRAP_ADMIN_USERNAME: "admin", KC_BOOTSTRAP_ADMIN_PASSWORD: "admin" },
      stdio: log("server"), detached: true,
    }),
    // The session gateway, both variants (env symmetry; a baseline build never connects).
    // NO --cookie-authority, unlike the strapi/inventree ports: the console's authority is
    // a bearer token the admin client attaches to every request, so it rides inside each
    // crossing and the gateway never needs to hold a jar.
    spawn(process.execPath, [
      fileURLToPath(new URL("../../packages/tierless/bin/tierless.mjs", import.meta.url)), "gateway",
      "--backend", FRONT,
      "--port", "8180",
      "--allow-origin", process.env.TIERLESS_ALLOWED_ORIGINS ||
        // 28080: the truth arm serves the page through the counting relay — its origin
        // must pass the ws gate or the ported arm silently measures no session
        ["8080", "18080", "28080"].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(","),
    ], { env: process.env, stdio: log("gateway"), detached: true }),
  ];
  const close = (): void => procs.forEach((p) => { try { process.kill(-p.pid!, "SIGTERM"); } catch { p.kill(); } });
  process.on("exit", close);
  // 'exit' does not fire on signal death (timeout(1) sends SIGTERM): without these, a
  // killed boot strands the DETACHED server group on :8080 for every later run
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { close(); process.exit(1); });
  try {
    await Promise.all([
      waitFor(FRONT + "/realms/master/.well-known/openid-configuration", 180_000),
      waitFor(GATEWAY, 60_000),
    ]);
  } catch (err) {
    close();
    throw err;
  }
  return { close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bootKeycloak();
  console.log(`keycloak up: ${FRONT}, gateway ${GATEWAY} — ctrl-c to stop`);
  await new Promise(() => { /* hold until killed */ });
}
