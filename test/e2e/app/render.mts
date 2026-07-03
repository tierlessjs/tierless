// Resolve an element tree to a plain vdom: call function components, flatten
// children, drop nullish nodes. The output is {type, props, children} where `type`
// is always a host-element string and props hold only data (className, onClick
// token, id, …) — no functions — so it serializes and ships to the browser tier.
export type Rendered = string | { type: string; props: Record<string, unknown>; children: Rendered[] } | null;
interface RawElement { type: string | ((props: any) => unknown); props: Record<string, unknown> & { children?: unknown } }

const flat = (c: unknown): unknown[] => (Array.isArray(c) ? c.flatMap(flat) : c == null || c === false || c === true ? [] : [c]);

export function render(el: unknown): Rendered {
  if (el == null || el === false || el === true) return null;
  if (typeof el === "string" || typeof el === "number") return String(el);
  const { type, props } = el as RawElement;
  if (typeof type === "function") return render(type(props));   // pure component: call it, recurse
  const kids = flat(props.children).map(render).filter((c): c is Rendered => c != null);
  const { children: _children, ...rest } = props;               // drop children from props; kids holds the rendered tree
  return { type, props: rest, children: kids };                 // host element: plain {type, props, children}
}

// Flatten the rendered vdom to its text — used by the headless regression check.
export const textOf = (n: Rendered): string => (n == null ? "" : typeof n === "string" ? n : n.children.map(textOf).filter(Boolean).join(" "));
