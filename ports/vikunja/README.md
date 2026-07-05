# Vikunja port (v2.3.0, sha 28b53783)

Status: recipe pinned; first fetch + treeHash pin, boot steps, journey selection, and the
workflow patches land with the actual port. Target properties (verified before selection):
frontend is Vite + Vue 3 with a Playwright e2e suite (the journeys come from there);
backend is a single Go binary with SQLite default — it is never modified, which is the
point: the port's server side is the REST-proxy adapter + gateway, proving "no backend
rewrite".

Planned boot (to be pinned exactly during the port):
  backend:  go build in ./ -> ./vikunja, VIKUNJA_DATABASE_TYPE=sqlite
  frontend: pnpm install && vite build / dev in ./frontend
  journeys: adapted from ./frontend/e2e (their Playwright suite), run via bench/harness

Note for sandboxed sessions: the fetch needs plain HTTPS to codeload.github.com — no
GitHub API, no auth. Environments that gate git hosts per-repo (like Claude Code remote
sessions) must have go-vikunja/vikunja added to the session scope, or run the recipe
anywhere unsandboxed.
