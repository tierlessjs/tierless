// RealWorld / Conduit orchestration, written as ONE tier-fluid program.
//   node src/transform.cjs bench/conduit.src.js bench/conduit.gen.mjs --bare
//
// These functions are the glue that, in the stock app, is split across a REST API and the
// React frontend's fetch hooks. Here they're one program: `api.*` are the backend's real
// service functions (server tier), `commit` renders previews (browser tier). The render
// starts on the server, assembles, and migrates to the browser carrying only what's shown —
// the full article bodies stay home as a §5 handle.
//
// previewsOf is pure (no resource) -> the transform emits it verbatim (native loop).
function previewsOf(articles) {
  let out = [];
  for (let i = 0; i < articles.length; i = i + 1) {
    const a = articles[i];
    out[i] = {                                  // exactly the fields the feed list renders — NOT the body
      slug: a.slug, title: a.title, description: a.description, tagList: a.tagList,
      author: a.author.username, image: a.author.image,
      favoritesCount: a.favoritesCount, createdAt: a.createdAt,
    };
  }
  return out;
}

// Scenario A — the home feed. Stock app: GET /tags + GET /articles?limit=10, the latter
// dragging every article's full Markdown body to render a title/description preview list.
function homeFeed(limit) {
  const tags = api.getTags();
  const articles = api.getArticles({ limit: limit });        // full articles (bodies included), server-side
  return commit({ tags: tags, articles: previewsOf(articles) });
}

// Scenario B — "articles favorited by people I follow." The fixed API has no endpoint for
// this cross-entity query, so a client must fan out one GET /articles?favorited=<user> per
// followed user (N round trips, each a full-body payload) and merge. Here the same loop runs
// on the server (it owns api.*), so the N calls never cross the wire — one migration ships
// the merged preview list.
function favoritedByFollowed(me) {
  const following = api.getFollowing(me);
  let collected = [];
  for (let i = 0; i < following.length; i = i + 1) {
    const arts = api.getArticles({ favorited: following[i] });
    for (let j = 0; j < arts.length; j = j + 1) { collected[collected.length] = arts[j]; }
  }
  return commit({ articles: previewsOf(collected) });
}

// Scenario C — a DEPENDENT chain: each step needs the previous article's `relatedSlug`, so a
// client can't parallelize it — it pays one sequential round trip per step. Here the chain
// runs on the server; one migration ships the small result. The win scales with depth.
function drilldown(depth) {
  let slug = "article-0";
  let total = 0;
  for (let i = 0; i < depth; i = i + 1) {
    const art = api.getArticle(slug);                 // depends on `slug` produced by the previous step
    total = total + art.favoritesCount;
    slug = art.relatedSlug;
  }
  return commit({ steps: depth, total: total });
}

// Scenario D — a single article page. The body IS rendered and the comments are independent
// of the article, so the stock API serves it in ~one parallel round trip with nothing to
// project away. Stackmix has no over-fetch to remove here — it just pays its codec overhead.
function articlePage(slug) {
  const article = api.getArticle(slug);
  const comments = api.getComments(slug);
  return commit({ article: article, comments: comments });   // everything here is rendered
}
