#!/usr/bin/env node
// npm create tierless@latest my-app  →  a running two-tier Tierless app in under a minute.
// Copies the template, stamps the app name, and prints the three next steps.
import { cpSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target) { console.error("usage: npm create tierless@latest <app-name>"); process.exit(2); }
const dest = path.resolve(target);
if (existsSync(dest) && readdirSync(dest).length) { console.error(`create-tierless: ${target} exists and is not empty`); process.exit(2); }

const template = fileURLToPath(new URL("./template", import.meta.url));
cpSync(template, dest, { recursive: true });
if (existsSync(path.join(dest, "_gitignore"))) renameSync(path.join(dest, "_gitignore"), path.join(dest, ".gitignore"));

const pkgPath = path.join(dest, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = path.basename(dest).toLowerCase().replace(/[^a-z0-9-_.]/g, "-");
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`
Created ${pkg.name}/ — one tierless program (app.src.js), a trusted api service
(api.server.mjs, runs as a reference-monitor sidecar), and a two-tier host.

  cd ${target}
  npm install
  npm run dev       # compiles the app and serves it — open the printed URL

Edit app.src.js and re-run; \`npx tierless explain app.src.js\` shows what compiles and why.
`);
