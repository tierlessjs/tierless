// Raw per-request wire logs are committed GZIPPED (they were 505k of the branch's
// 513k inserted lines / 76.9 MB plain; derived summaries — measure rows, report
// outputs — stay plain). Analyzers read either form through this seam, so a fresh
// uncommitted log and a committed .gz behave identically.
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/** Text of a JSONL file that may be stored as <path> or <path>.gz. */
export function readJsonlText(path: string): string {
  const p = path.endsWith(".gz") ? path.slice(0, -3) : path;
  if (existsSync(p)) return readFileSync(p, "utf8");
  return gunzipSync(readFileSync(p + ".gz")).toString("utf8");
}

/** Parsed rows; lines that fail to parse are dropped (a killed run can truncate the tail). */
export function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  return readJsonlText(path).split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r !== null);
}

/** Strip a trailing .gz so directory listings dedupe to logical names. */
export const logicalName = (f: string): string => f.replace(/\.gz$/, "");

/** Filter a readdir listing to logical JSONL names matching `suffix`, deduped. */
export function jsonlNames(files: string[], suffix: string): string[] {
  return [...new Set(files.map(logicalName))].filter((f) => f.endsWith(suffix)).sort();
}
