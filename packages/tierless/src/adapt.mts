// Adapting EXISTING apps — the corpus program's rung 3 (docs/corpus.md).
//
// An existing app's backend is never rewritten: its REST endpoints become the resource
// space directly. A workflow module calls paths, not schema entries —
//
//   "use tierless";
//   export function openProject(id, view) {
//     const user = api.get("/user");
//     const project = api.get("/projects/" + id);
//     const tasks = api.get("/projects/" + id + "/views/" + view + "/tasks?...");
//     return { "/user": user, ["/projects/" + id]: project, ... };
//   }
//
// — and restResources() is the server-side exec that services api.get/api.post by
// calling the real backend over localhost, forwarding the end user's bearer token. The
// gateway holds NO authority of its own: every request is authorized by the backend
// exactly as if the browser had sent it. (The reference-monitor api service remains the
// trust model for apps that own their backend; this adapter is the no-rewrite seam.)
import type { Exec, ResourceRequest } from "./types.mjs";

export interface RestResourcesOpts {
  /** Bearer token forwarded as Authorization (the end user's — from the session). */
  token?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** An Exec servicing `api.get(path)` / `api.post(path, body)` against a real REST base URL.
 *  Resolves to an ENVELOPE { status, headers, body } — apps read semantics from custom
 *  response headers (pagination counts, permission levels), so they must migrate with the
 *  body. `headers` carries content-type and every x-* header. Non-2xx throws, unwinding
 *  into the workflow's own try/catch like any resource error. */
export function restResources(baseUrl: string, { token, headers = {}, fetchImpl = fetch }: RestResourcesOpts = {}): Exec {
  const base = baseUrl.replace(/\/$/, "");
  return async (req: ResourceRequest) => {
    const m = /^api\.(get|post|put|patch|delete)$/.exec(req.name);
    if (!m) throw new Error("restResources: unknown resource " + req.name + " (use api.get/api.post/...)");
    const method = m[1].toUpperCase();
    const [path, body] = req.args as [string, unknown?];
    if (typeof path !== "string" || !path.startsWith("/")) throw new Error("restResources: first argument must be an absolute path, got " + JSON.stringify(path));
    const r = await fetchImpl(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: token.startsWith("Bearer ") ? token : "Bearer " + token } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    const isJson = (r.headers.get("content-type") || "").includes("json");
    if (!r.ok) throw new Error(`api.${m[1]} ${path}: ${r.status} ${text.slice(0, 200)}`);
    const hdrs: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (k === "content-type" || k.startsWith("x-")) hdrs[k] = v; });
    return { status: r.status, headers: hdrs, body: isJson ? JSON.parse(text) : text };
  };
}
