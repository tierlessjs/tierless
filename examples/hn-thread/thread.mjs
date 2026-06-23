// The application, authored as ordinary TypeScript and compiled to Stackmix IR by
// the frontend. Both processes build a runtime from this so they run the identical
// module (resume is by instruction offset). No tier annotations: placement is
// inferred from which resources each call touches — db.* force the server, ui.*
// the client.
import { createRuntime } from "#stackmix";

export const N = 2000;

export const SRC = `
declare const db: { items(): number[]; title(id: number): string };
declare const ui: { render(lines: string[]): number };

function build(ids: number[]): string[] {
  const out = [];
  for (let i = 0; i < ids.length; i = i + 1) {
    out.push(db.title(ids[i]));     // db.title: server resource (we're already there)
  }
  return out;
}

function main(): number {
  const ids = db.items();           // server resource -> migrate to the server
  const lines = build(ids);         // nested call runs on the server; db.title is local
  return ui.render(lines);          // client resource -> migrate back to the client
}
`;

// Each process builds its own runtime — there is no shared global program.
export function buildRuntime() {
  const rt = createRuntime();
  rt.load(SRC, {
    entry: "main",
    resources: ["db.items", "db.title", "ui.render"],
    file: "app-thread.ts",
  });
  return rt;
}
