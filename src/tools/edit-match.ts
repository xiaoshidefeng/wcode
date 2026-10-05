// Multi-strategy old_string matching for the edit tool, ported from
// opencode's edit.ts (which credits cline / gemini-cli).
//
// Order: exact → line-trimmed → block-anchor (similarity ≥ 0.65) →
// indentation-flexible → escape-normalized. Fuzzy strategies enforce a
// disproportion guard so a loose match can never silently rewrite a huge
// region, and every strategy enforces uniqueness unless replaceAll.

import { ToolError } from "./types.js";

interface Match {
  start: number;
  end: number;
  replacement: string;
}

const SIMILARITY_THRESHOLD = 0.65;
const MAX_LEVENSHTEIN_CHARS = 20_000;

export interface ApplyResult {
  updated: string;
  strategy: string;
  count: number;
}

export function applyReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ApplyResult | null {
  if (oldString === "") {
    throw new ToolError(
      "old_string is empty — use the write tool to create files or overwrite full content instead.",
    );
  }

  // 1. exact
  const exact = collectExact(content, oldString, newString);
  if (exact.length > 0) {
    if (exact.length > 1 && !replaceAll) {
      throw new ToolError(
        `old_string appears ${exact.length} times — add surrounding lines to make it unique, or set replace_all=true.`,
      );
    }
    const count = replaceAll ? exact.length : 1;
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : spliceOne(content, exact[0]!);
    return { updated, strategy: "exact", count };
  }
  if (replaceAll) {
    throw new ToolError(
      "old_string not found and replace_all=true requires an exact match — re-read the file and copy the text exactly.",
    );
  }

  const oldLines = oldString.split("\n");
  const contentLines = content.split("\n");

  // 2. line-trimmed
  const trimmed = collectByLines(contentLines, oldLines, newString, (a, b) => a.trim() === b.trim());
  if (trimmed) return finish(content, trimmed, "line-trimmed", oldString, replaceAll);

  // 3. block-anchor (first/last line anchors + middle similarity)
  const anchored = collectByAnchor(contentLines, oldLines, newString);
  if (anchored) return finish(content, anchored, "block-anchor", oldString, replaceAll);

  // 4. indentation-flexible (leading whitespace ignored, indent re-applied)
  const flex = collectIndentFlexible(contentLines, oldLines, newString);
  if (flex) return finish(content, flex, "indentation-flexible", oldString, replaceAll);

  // 5. escape-normalized (literal \n \t in the needle vs real whitespace)
  const unescaped = oldString.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  if (unescaped !== oldString) {
    const esc = collectExact(content, unescaped, newString.replace(/\\n/g, "\n").replace(/\\t/g, "\t"));
    if (esc.length > 0) {
      if (esc.length > 1) throw new ToolError(`escaped old_string appears ${esc.length} times — make it unique first.`);
      return { updated: spliceOne(content, esc[0]!), strategy: "escape-normalized", count: 1 };
    }
  }

  return null;
}

function finish(
  content: string,
  match: Match & { disproportion: boolean },
  strategy: string,
  oldString: string,
  _replaceAll: boolean,
): ApplyResult {
  if (match.disproportion) {
    throw new ToolError(
      `fuzzy ${strategy} match was disproportionate (matched region far larger than old_string, ` +
        `${match.end - match.start} vs ${oldString.length} chars) — refused to protect the file. ` +
        "Re-read the file and send a more exact old_string.",
    );
  }
  return { updated: spliceOne(content, match), strategy, count: 1 };
}

function spliceOne(content: string, m: Match): string {
  return content.slice(0, m.start) + m.replacement + content.slice(m.end);
}

function collectExact(content: string, needle: string, replacement: string): Match[] {
  const out: Match[] = [];
  let pos = 0;
  for (;;) {
    const idx = content.indexOf(needle, pos);
    if (idx === -1) break;
    out.push({ start: idx, end: idx + needle.length, replacement });
    pos = idx + needle.length;
  }
  return out;
}

function lineOffset(lines: string[], line: number): number {
  let off = 0;
  for (let i = 0; i < line; i++) off += lines[i]!.length + 1;
  return off;
}

/** Locate `needleLines` inside `contentLines` with a per-line comparator. */
function findLineBlocks(
  contentLines: string[],
  needleLines: string[],
  compare: (a: string, b: string) => boolean,
): { startLine: number; endLine: number }[] {
  const n = needleLines.length;
  if (n === 0 || contentLines.length < n) return [];
  const out: { startLine: number; endLine: number }[] = [];
  for (let i = 0; i + n <= contentLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!compare(contentLines[i + j]!, needleLines[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ startLine: i, endLine: i + n });
  }
  return out;
}

function collectByLines(
  contentLines: string[],
  oldLines: string[],
  newString: string,
  compare: (a: string, b: string) => boolean,
): (Match & { disproportion: boolean }) | null {
  const blocks = findLineBlocks(contentLines, oldLines, compare);
  if (blocks.length === 0) return null;
  if (blocks.length > 1) {
    throw new ToolError(`old_string (ignoring line whitespace) appears ${blocks.length} times — make it unique first.`);
  }
  const b = blocks[0]!;
  const content = contentLines.join("\n");
  const start = lineOffset(contentLines, b.startLine);
  const end = lineOffset(contentLines, b.endLine) - 1;
  return {
    start,
    end,
    replacement: newString,
    disproportion: regionDisproportionate(content.slice(start, end), oldLines.join("\n")),
  };
}

function collectByAnchor(
  contentLines: string[],
  oldLines: string[],
  newString: string,
): (Match & { disproportion: boolean }) | null {
  const n = oldLines.length;
  if (n < 3) return null;
  const first = oldLines[0]!.trim();
  const last = oldLines[n - 1]!.trim();
  const middleOld = oldLines.slice(1, -1);
  const matches: { startLine: number; endLine: number }[] = [];
  for (let i = 0; i + n <= contentLines.length; i++) {
    if (contentLines[i]!.trim() !== first) continue;
    if (contentLines[i + n - 1]!.trim() !== last) continue;
    const middleFile = contentLines.slice(i + 1, i + n - 1);
    const a = normalizeWs(middleFile.join("\n"));
    const b = normalizeWs(middleOld.join("\n"));
    if (a.length + b.length > MAX_LEVENSHTEIN_CHARS) continue;
    if (similarity(a, b) < SIMILARITY_THRESHOLD) continue;
    matches.push({ startLine: i, endLine: i + n });
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new ToolError(`anchor-matched ${matches.length} similar blocks — include more unique lines.`);
  }
  const b0 = matches[0]!;
  const content = contentLines.join("\n");
  const start = lineOffset(contentLines, b0.startLine);
  const end = lineOffset(contentLines, b0.endLine) - 1;
  return {
    start,
    end,
    replacement: newString,
    disproportion: regionDisproportionate(content.slice(start, end), oldLines.join("\n")),
  };
}

function collectIndentFlexible(
  contentLines: string[],
  oldLines: string[],
  newString: string,
): (Match & { disproportion: boolean }) | null {
  // Whitespace inside lines is ignored entirely (opencode semantics) — this
  // catches what line-trimmed cannot: spaces collapsed or added mid-line.
  const strip = (s: string) => s.replace(/\s+/g, "");
  const indentOf = (s: string) => s.match(/^[ \t]*/)?.[0] ?? "";
  const blocks = findLineBlocks(contentLines, oldLines, (a, b) => strip(a) === strip(b));
  if (blocks.length === 0) return null;
  if (blocks.length > 1) {
    throw new ToolError(`old_string (ignoring indentation) appears ${blocks.length} times — make it unique first.`);
  }
  const b = blocks[0]!;
  // Re-indent the replacement to the file's indentation at the match site;
  // internal spacing of each replacement line is preserved verbatim.
  const fileIndent = indentOf(contentLines[b.startLine]!);
  const newLines = newString.split("\n").map((line) => (line === "" ? line : fileIndent + line.replace(/^\s+/, "")));
  const content = contentLines.join("\n");
  const start = lineOffset(contentLines, b.startLine);
  const end = lineOffset(contentLines, b.endLine) - 1;
  return {
    start,
    end,
    replacement: newLines.join("\n"),
    disproportion: regionDisproportionate(content.slice(start, end), oldLines.join("\n")),
  };
}

function regionDisproportionate(region: string, oldString: string): boolean {
  const regionLines = region.split("\n").length;
  const oldLines = oldString.split("\n").length;
  if (regionLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (region.length > Math.max(500, oldString.length * 4)) return true;
  return false;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

