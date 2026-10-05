// Shared helpers for built-in tools.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const MAX_TOOL_OUTPUT_BYTES = 30_000;

/** Head+tail truncation with an explicit elision marker. */
export function truncateOutput(s: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): string {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  const head = Math.floor(maxBytes * 0.4);
  const tail = maxBytes - head;
  let headStr = s.slice(0, findCharBoundary(s, head));
  let tailStr = s.slice(findCharBoundary(s, s.length - findCharBoundaryBack(s, tail)));
  const dropped = Buffer.byteLength(s) - Buffer.byteLength(headStr) - Buffer.byteLength(tailStr);
  headStr = headStr.replace(/\n$/, "");
  tailStr = tailStr.replace(/^\n/, "");
  return `${headStr}\n\n… [+${dropped} bytes truncated, showing head and tail] …\n\n${tailStr}`;
}

function findCharBoundary(s: string, byteOffset: number): number {
  let i = byteOffset;
  while (i > 0 && Buffer.byteLength(s.slice(0, i)) > byteOffset) i--;
  return i;
}
function findCharBoundaryBack(s: string, bytesFromEnd: number): number {
  let i = bytesFromEnd;
  while (i > 0 && Buffer.byteLength(s.slice(s.length - i)) > bytesFromEnd) i--;
  return i;
}

/** cat -n style line numbers; Edit must strip these before matching. */
export function addLineNumbers(lines: string[], startLine = 1): string {
  const width = String(startLine + lines.length).length;
  return lines.map((line, i) => `${String(i + startLine).padStart(width, " ")}  ${line}`).join("\n");
}
export function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\s\s/, ""))
    .join("\n");
}

export function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

export function fileHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/** Convert a glob pattern (*, **, ?, {a,b}, [abc]) into a RegExp. */
export function globToRegex(pattern: string): RegExp {
  return new RegExp(`^${globSource(pattern)}$`);
}

/** Unanchored glob source; recurses for brace alternation. */
function globSource(pattern: string): string {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more path segments; bare `**` matches anything.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "{") {
      let depth = 1;
      let body = "";
      let j = i + 1;
      while (j < pattern.length && depth > 0) {
        if (pattern[j] === "{") depth++;
        else if (pattern[j] === "}") {
          depth--;
          if (depth === 0) break;
        }
        body += pattern[j]!;
        j++;
      }
      re += `(?:${body.split(",").map((alt) => globSource(alt)).join("|")})`;
      i = j + 1;
      continue;
    }
    if (c === "[" && pattern[i + 1] !== undefined) {
      let j = i + 1;
      let body = "";
      if (pattern[j] === "!" || pattern[j] === "^") {
        body += "^";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        body += pattern[j]!.replace(/[-\\^\]]/g, "\\$&");
        j++;
      }
      re += `[${body}]`;
      i = j + 1;
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return re;
}

/** Directories always skipped when walking the tree. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".wcode",
]);

/**
 * Recursively list files under root, skipping ignored dirs and .gitignore
 * entries. Relative paths returned. Never follows symlinks out of the root.
 */
export async function listFiles(
  root: string,
  opts: { maxEntries?: number; respectGitignore?: boolean } = {},
): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  const max = opts.maxEntries ?? 10_000;
  const ignore = opts.respectGitignore === false ? undefined : await loadGitignorePatterns(root);

  async function visit(dir: string, prefix: string): Promise<void> {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= max) return;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name === "build" && prefix === "") continue;
        if (ignore?.some((re) => re.test(rel))) continue;
        await visit(resolve(root, rel), rel);
      } else if (entry.isFile()) {
        if (ignore?.some((re) => re.test(rel))) continue;
        out.push(rel);
      }
    }
  }

  await visit(root, "");
  return out;
}

async function loadGitignorePatterns(root: string): Promise<RegExp[]> {
  const { readFile } = await import("node:fs/promises");
  const patterns: RegExp[] = [];
  try {
    const content = await readFile(resolve(root, ".gitignore"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      patterns.push(globToRegex(trimmed.replace(/^\//, "").replace(/\/$/, "")));
    }
  } catch {
    /* no gitignore */
  }
  return patterns;
}
