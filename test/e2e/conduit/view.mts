// Conduit's view layer: the same minimal h/render as the Tasks app, plus the presentational
// components for the three views. Components are PURE (no resource) so the transform emits them
// verbatim; they emit serializable onClick EVENT TOKENS (plain objects, never closures), because
// the rendered vdom ships to the browser tier and a click there resolves the continuation with the
// token. Input values (a comment body, the editor fields) are merged into the token by the client.
export const h = (type: string | ((props: any) => unknown), props: Record<string, unknown> | null, ...children: unknown[]) =>
  ({ type, props: { ...(props || {}), children } });

export type Rendered = string | { type: string; props: Record<string, unknown>; children: Rendered[] } | null;
interface RawElement { type: string | ((props: any) => unknown); props: Record<string, unknown> & { children?: unknown } }

const flat = (c: unknown): unknown[] => (Array.isArray(c) ? c.flatMap(flat) : c == null || c === false || c === true ? [] : [c]);
export function render(el: unknown): Rendered {
  if (el == null || el === false || el === true) return null;
  if (typeof el === "string" || typeof el === "number") return String(el);
  const { type, props } = el as RawElement;
  if (typeof type === "function") return render(type(props));     // pure component: call it, recurse
  const kids = flat(props.children).map(render).filter((c): c is Rendered => c != null);
  const { children: _children, ...rest } = props;
  return { type, props: rest, children: kids };
}
export const textOf = (n: Rendered): string => (n == null ? "" : typeof n === "string" ? n : n.children.map(textOf).filter(Boolean).join(" "));

// Data shapes the components render — kept local (not imported from conduit/api.mts) since these
// components only ever see whatever props the compiled continuation passes them.
interface ArticlePreview { slug: string; title: string; description: string; tagList: string[]; author: string; favoritesCount: number }
interface ArticleComment { id: number; body: string; author: string }

// ---- home feed ----
export function TagList({ tags, active }: { tags: string[]; active: string }) {
  return h("div", { className: "tags" }, [
    h("button", { key: "_all", className: active === "" ? "active" : "", onClick: { ev: "home" } }, "all"),
    ...tags.map((t) => h("button", { key: t, className: t === active ? "active" : "", onClick: { ev: "tag", tag: t } }, "#" + t)),
  ]);
}
export function Preview({ article }: { article: ArticlePreview }) {
  return h("div", { className: "preview" },
    h("a", { className: "title", onClick: { ev: "open", slug: article.slug } }, article.title),
    h("p", { className: "desc" }, article.description),
    h("span", { className: "meta" }, "@" + article.author + " · ♥ " + article.favoritesCount + " · " + article.tagList.join(" ")));
}
export function HomeView({ tags, feed, tag }: { tags: string[]; feed: ArticlePreview[]; tag: string }) {
  return h("div", { className: "home" }, h("h1", null, "conduit"), h(TagList, { tags, active: tag }),
    feed.length === 0
      ? h("p", { className: "empty" }, "No articles" + (tag ? " tagged #" + tag : "") + ".")
      : h("div", { className: "feed" }, feed.map((a) => h(Preview, { key: a.slug, article: a }))),
    h("button", { className: "new", onClick: { ev: "new" } }, "+ New Article"));
}

// ---- article page ----
export function Comment({ comment }: { comment: ArticleComment }) {
  return h("div", { className: "comment" }, h("p", null, comment.body),
    h("span", { className: "by" }, "@" + comment.author),
    h("button", { onClick: { ev: "uncomment", id: comment.id } }, "x"));
}
export function ArticleView({ article, comments }: {
  article: { title: string; author: string; createdAt: string; favorited: boolean; favoritesCount: number; tagList: string[]; body: string };
  comments: ArticleComment[];
}) {
  return h("div", { className: "article" },
    h("button", { className: "back", onClick: { ev: "home" } }, "← back"),
    h("h1", null, article.title),
    h("div", { className: "byline" }, "@" + article.author + " · " + article.createdAt,
      h("button", { className: article.favorited ? "fav on" : "fav", onClick: { ev: "favorite" } },
        (article.favorited ? "♥ " : "♡ ") + article.favoritesCount)),
    h("div", { className: "tags" }, article.tagList.map((t) => h("span", { key: t, className: "tag" }, "#" + t))),
    h("div", { className: "body" }, article.body),
    h("h3", null, comments.length + " comments"),
    h("div", { className: "comments" }, comments.map((c) => h(Comment, { key: c.id, comment: c }))),
    h("div", { className: "addcomment" }, h("textarea", { id: "comment-body", placeholder: "Write a comment…" }),
      h("button", { className: "post", onClick: { ev: "comment" } }, "Post Comment")));
}

// ---- editor ----
export function EditorView({ draft, error }: { draft: { title: string; body: string; tags: string }; error: string | null }) {
  return h("div", { className: "editor" }, h("h1", null, "New Article"),
    error ? h("p", { className: "error" }, error) : null,
    h("input", { id: "art-title", placeholder: "Article Title", value: draft.title }),
    h("textarea", { id: "art-body", placeholder: "Write your article (markdown)…", value: draft.body }),
    h("input", { id: "art-tags", placeholder: "tags (space separated)", value: draft.tags }),
    h("button", { className: "publish", onClick: { ev: "publish" } }, "Publish"),
    h("button", { className: "cancel", onClick: { ev: "home" } }, "Cancel"));
}
