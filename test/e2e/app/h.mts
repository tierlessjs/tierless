// Minimal createElement. Returns a plain, fully serializable element
// {type, props, children} — no React dependency. The elements are resolved by
// render.mjs, and onClick carries an EVENT TOKEN (a plain object like
// {ev:"filter", value:"done"}), never a closure, so the whole vdom crosses the wire.
export const h = (type: string | ((props: any) => unknown), props: Record<string, unknown> | null, ...children: unknown[]) =>
  ({ type, props: { ...(props || {}), children } });
