// Conduit (RealWorld) as ONE tier-fluid program — a real multi-view app, not a benchmark. A routing
// loop moves between the home feed, an article page, and the editor. `api.*` runs on the server (it
// owns the data); `commit` renders on the browser. Each view loads its data on the server and the
// rendered vdom migrates to the browser; a click resolves the continuation with an event token and
// the loop routes on. No async, no fetch, no client/server split — the whole app is this one program.

function loadHome(tag) {
  const tags = api.getTags();
  const feed = api.feed(tag);                          // server projects bodies away -> small previews
  return render(h(HomeView, { tags: tags, feed: feed, tag: tag }));
}

function loadArticle(slug) {
  const article = api.getArticle(slug);                // full article (body included) + its favorite state
  const comments = api.getComments(slug);
  return render(h(ArticleView, { article: article, comments: comments }));
}

function loadEditor(draft, error) {
  return render(h(EditorView, { draft: draft, error: error }));
}

function App() {
  let route = "home";
  let tag = "";
  let slug = "";
  let draft = { title: "", body: "", tags: "" };
  let error = "";
  while (true) {
    let vdom;
    if (route === "home") vdom = loadHome(tag);          // suspendable call as an assignment RHS, inside a branch
    else if (route === "article") vdom = loadArticle(slug);
    else vdom = loadEditor(draft, error);
    const ev = commit(vdom);
    error = "";
    if (ev.ev === "open") { slug = ev.slug; route = "article"; }
    else if (ev.ev === "tag") { tag = ev.tag; route = "home"; }
    else if (ev.ev === "home") { tag = ""; route = "home"; }
    else if (ev.ev === "favorite") api.toggleFavorite(slug);    // stays on the article; the re-render reflects it
    else if (ev.ev === "comment") api.addComment(slug, ev.body);
    else if (ev.ev === "uncomment") api.deleteComment(ev.id);
    else if (ev.ev === "new") { draft = { title: "", body: "", tags: "" }; route = "editor"; }
    else if (ev.ev === "publish") {
      try {
        const created = api.publish(ev.title, ev.body, ev.tags);   // validates on the server; throws on a blank title
        slug = created.slug;
        route = "article";
      } catch (e) {
        error = e.message;                                          // the server-tier throw is caught here, across the boundary
        draft = { title: ev.title, body: ev.body, tags: ev.tags };
        route = "editor";
      }
    } else break;
  }
  return "session ended";
}
