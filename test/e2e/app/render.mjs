const flat = (c) => (Array.isArray(c) ? c.flatMap(flat) : c == null || c === false || c === true ? [] : [c]);
export function render(el) {
    if (el == null || el === false || el === true)
        return null;
    if (typeof el === "string" || typeof el === "number")
        return String(el);
    const { type, props } = el;
    if (typeof type === "function")
        return render(type(props)); // pure component: call it, recurse
    const kids = flat(props.children).map(render).filter((c) => c != null);
    const { children: _children, ...rest } = props; // drop children from props; kids holds the rendered tree
    return { type, props: rest, children: kids }; // host element: plain {type, props, children}
}
// Flatten the rendered vdom to its text — used by the headless regression check.
export const textOf = (n) => (n == null ? "" : typeof n === "string" ? n : n.children.map(textOf).filter(Boolean).join(" "));
