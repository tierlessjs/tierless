export declare function globToRegexPattern(glob: string): string;
/** The force-browser descriptor shape shared between the page global
 *  (`window.__tierlessForceBrowser`), adapt-auto's matcher, and the Playwright route
 *  recorder that populates it: a glob, or a RegExp split into [source, flags] so it
 *  survives serialization into the page. */
export type ForceBrowserDescriptor = {
    glob: string;
} | {
    re: [string, string];
};
export declare function matchesForceBrowser(list: readonly ForceBrowserDescriptor[] | undefined, url: string): boolean;
