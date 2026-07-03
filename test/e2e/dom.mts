// Browser-tier rendering: turn the serializable vdom (plain {type, props, children}
// produced by render.mjs on the server) into real HTML. onClick event tokens — which
// are plain serializable objects, NOT closures — ride along as `data-ev` attributes;
// the page's click delegation reads them back and returns them to the continuation.
import type { Rendered } from "./app/render.mts";

const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);
const PASS: Record<string, string> = { className: "class", id: "id", placeholder: "placeholder", value: "value", type: "type" };
const esc = (s: unknown): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escSq = (s: unknown): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "&#39;"); // single-quoted attr: keep " literal so JSON survives

// n is typed unknown, not Rendered: the false/true guard below is defensive against whatever
// a caller actually passes (render.mjs's real output never includes booleans, but nothing
// enforces that at this boundary), so narrowing to Rendered up front would make it dead code.
export function vdomToHtml(n: unknown): string {
  if (n == null || n === false || n === true) return "";
  if (typeof n === "string" || typeof n === "number") return esc(n);
  const { type, props = {}, children = [] } = n as Exclude<Rendered, string | null>;
  const attrs: string[] = [];
  for (const k of Object.keys(props)) {
    if (k === "onClick") attrs.push(`data-ev='${escSq(JSON.stringify(props[k]))}'`);
    else if (PASS[k]) attrs.push(`${PASS[k]}="${esc(props[k])}"`);
  }
  const open = `<${type}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  if (VOID.has(type)) return open;
  return `${open}${children.map(vdomToHtml).join("")}</${type}>`;
}

export const shell = (bodyHtml: string): string => `<!doctype html><html><head><meta charset="utf-8">
<style>body{font:14px system-ui;margin:1rem}.stats{margin:.5rem 0}.task{display:flex;gap:.5rem;align-items:center}
.badge{font-size:11px;padding:1px 6px;border-radius:6px;background:#eee}button{cursor:pointer}</style></head>
<body><div id="root">${bodyHtml}</div></body></html>`;
