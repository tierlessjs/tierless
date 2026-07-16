// URL glob → regex, token-for-token Playwright's own compiler (playwright-core
// urlMatch.globToRegexPattern; the live proof test/e2e/pw-waits-live.mts differentially
// verifies the port against the installed copy). One implementation, two consumers with
// the same contract: tierless/playwright matches crossings the way the suite's own
// waits would, and the force-browser seam (adapt-auto) matches routes the way the
// suite's route() patterns read. Current Playwright semantics: `*` → any run without
// `/`, `**` → any run at all, `{a,b}` → alternation, `\` escapes — and `?`/`[`/`]` are
// LITERALS (URLs carry query strings), so a no-wildcard string compiles to an anchored
// literal and exact-equality falls out. Browser-safe: no imports.
const GLOB_ESCAPE = new Set(["$", "^", "+", ".", "*", "(", ")", "|", "\\", "?", "{", "}", "[", "]"]);
export function globToRegexPattern(glob) {
    const tokens = ["^"];
    let inGroup = false;
    for (let i = 0; i < glob.length; ++i) {
        const c = glob[i];
        if (c === "\\" && i + 1 < glob.length) {
            const nxt = glob[++i];
            tokens.push(GLOB_ESCAPE.has(nxt) ? "\\" + nxt : nxt);
            continue;
        }
        if (c === "*") {
            let stars = 1;
            while (glob[i + 1] === "*") {
                stars++;
                i++;
            }
            tokens.push(stars > 1 ? "(.*)" : "([^/]*)");
            continue;
        }
        switch (c) {
            case "{":
                inGroup = true;
                tokens.push("(");
                break;
            case "}":
                inGroup = false;
                tokens.push(")");
                break;
            case ",":
                tokens.push(inGroup ? "|" : "\\,");
                break;
            default: tokens.push(GLOB_ESCAPE.has(c) ? "\\" + c : c);
        }
    }
    tokens.push("$");
    return tokens.join("");
}
// Match a request URL against force-browser descriptors. Tries the full URL and the
// query-stripped URL (a glob like **/rest/executions should keep ?filter= requests
// browser-side too — for interception purposes looser is safer: a request forced to
// the browser needlessly still behaves stock; one missed breaks the mock visibly).
export function matchesForceBrowser(list, url) {
    if (!list || !list.length)
        return false;
    const candidates = [url, url.split("?")[0]];
    return list.some((d) => {
        const re = "re" in d ? new RegExp(d.re[0], d.re[1]) : new RegExp(globToRegexPattern(d.glob));
        return candidates.some((c) => re.test(c));
    });
}
