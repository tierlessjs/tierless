// Conduit's server tier — the data the app's api.* calls resolve against. In-memory (a fresh seed
// per run); the real point is the shapes: feed() returns PREVIEWS (bodies projected away, so the big
// Markdown never crosses the wire), while getArticle() returns the full body for the page that
// renders it. That projection is the over-fetch the framework removes by running the read where the
// data lives. publish() validates and throws on a blank title — exercised across the tier boundary.
let DB;
const body = (t) => "# " + t + "\n\n" + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8);

export function seed() {
  DB = {
    nextArt: 4, nextComment: 4,
    articles: [
      { slug: "hello-world", title: "Hello World", description: "A friendly intro to conduit.", body: body("Hello World"), tagList: ["intro", "welcome"], author: "ana", favoritesCount: 3, favorited: false, createdAt: "2026-01-02" },
      { slug: "deep-dive-cps", title: "A Deep Dive into CPS", description: "How continuations move across tiers.", body: body("CPS"), tagList: ["intro", "compilers"], author: "bo", favoritesCount: 7, favorited: false, createdAt: "2026-01-05" },
      { slug: "ten-tips", title: "Ten Tips for Faster Builds", description: "Shaving seconds off CI.", body: body("Builds"), tagList: ["devops"], author: "cy", favoritesCount: 1, favorited: false, createdAt: "2026-01-09" },
    ],
    comments: {
      "hello-world": [{ id: 1, body: "Great intro!", author: "bo" }, { id: 2, body: "Welcome aboard.", author: "cy" }],
      "deep-dive-cps": [{ id: 3, body: "Mind blown.", author: "ana" }],
    },
  };
}

const find = (slug) => DB.articles.find((a) => a.slug === slug);
const preview = (a) => ({ slug: a.slug, title: a.title, description: a.description, tagList: a.tagList, author: a.author, favoritesCount: a.favoritesCount, createdAt: a.createdAt });

export function getTags() { const s = new Set(); for (const a of DB.articles) for (const t of a.tagList) s.add(t); return [...s].sort(); }
export function feed(tag) {                                       // PREVIEWS only — the bodies stay home
  const rows = (tag ? DB.articles.filter((a) => a.tagList.includes(tag)) : DB.articles).slice().sort((a, b) => b.favoritesCount - a.favoritesCount);
  return rows.map(preview);
}
export function getArticle(slug) { const a = find(slug); if (!a) throw new Error("no article " + slug); return { ...a }; }   // full body
export function getComments(slug) { return (DB.comments[slug] || []).slice(); }
export function toggleFavorite(slug) { const a = find(slug); if (!a) throw new Error("no article " + slug); a.favorited = !a.favorited; a.favoritesCount += a.favorited ? 1 : -1; return { favorited: a.favorited, favoritesCount: a.favoritesCount }; }
export function addComment(slug, text) { if (!text || !text.trim()) throw new Error("comment can't be blank"); const c = { id: DB.nextComment++, body: text.trim(), author: "me" }; (DB.comments[slug] || (DB.comments[slug] = [])).push(c); return c; }
export function deleteComment(id) { for (const slug of Object.keys(DB.comments)) DB.comments[slug] = DB.comments[slug].filter((c) => c.id !== id); return { ok: true }; }
export function publish(title, text, tags) {
  if (!title || !title.trim()) throw new Error("title can't be blank");
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const art = { slug, title: title.trim(), description: (text || "").slice(0, 60), body: text || "", tagList: (tags || "").split(/\s+/).filter(Boolean), author: "me", favoritesCount: 0, favorited: false, createdAt: "2026-02-01" };
  DB.articles.unshift(art); DB.comments[slug] = [];
  return { slug };
}
