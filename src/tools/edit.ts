// edit: exact string replacement (claude-code style). old_string must match
// the file exactly and uniquely unless replace_all is set; CRLF is normalized
// for matching and restored on write.

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { applyReplacement } from "./edit-match.js";
import type { Tool, ToolContext, ToolOutput } from "./types.js";
import { ToolError, bool, str } from "./types.js";
import { resolvePath } from "./util.js";

const DESCRIPTION = `Make a targeted edit to an existing file by exact string replacement.

Usage:
- "old_string" must match the file content EXACTLY, including whitespace and indentation.
- "old_string" must be unique in the file. If it appears multiple times, include more surrounding lines to make it unique, or set replace_all=true to change every occurrence.
- "new_string" must differ from "old_string".
- To delete text, set "new_string" to the empty string.
- The file must have been read with the read tool before editing.
- Multiple edits to one file: prefer one edit call per change, but reuse knowledge from previous results.

CRITICAL: line numbers shown by the read tool (leading "42  ") are display only — never include them in old_string.`;

export function createEditTool(): Tool {
  return {
    name: "edit",
    description: DESCRIPTION,
    readOnly: false,
    mutation: "file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to edit, absolute or relative to the working directory" },
        old_string: { type: "string", description: "Exact text to replace; must be unique in the file" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      const rawPath = str(args, "path");
      const oldString = str(args, "old_string");
      const newString = str(args, "new_string");
      const replaceAll = bool(args, "replace_all");
      const path = resolvePath(ctx.cwd, rawPath);

      if (oldString === newString) throw new ToolError("old_string and new_string are identical — nothing to change");

      const st = await stat(path).catch(() => null);
      if (!st || st.isDirectory()) throw new ToolError(`file not found: ${path}`);

      const state = ctx.readFileState.get(path);
      if (!state) {
        throw new ToolError(`refusing to edit ${path}: it has not been read in this session. Read it first.`);
      }
      const currentStat = await stat(path);
      if (currentStat.mtimeMs !== state.mtimeMs) {
        throw new ToolError(`refusing to edit ${path}: modified after the last read. Read it again, then edit.`);
      }

      const raw = await readFile(path, "utf8");
      const usesCrlf = raw.includes("\r\n");
      const content = usesCrlf ? raw.replace(/\r\n/g, "\n") : raw;
      const needle = oldString.replace(/\r\n/g, "\n");
      const replacement = newString.replace(/\r\n/g, "\n");

      // Helpful hint before the fallback chain: the model may have copied the
      // read tool's line-number prefix.
      const stripped = stripLineNumberPrefix(needle);
      if (stripped !== needle && content.includes(stripped)) {
        throw new ToolError(
          "old_string not found, but a match exists after stripping the read tool's line-number prefix. " +
            "Send old_string WITHOUT the leading line numbers.",
        );
      }

      let result;
      try {
        result = applyReplacement(content, needle, replacement, replaceAll);
      } catch (err) {
        if (err instanceof ToolError) {
          throw new ToolError(`${err.message} (file: ${rawPath})`);
        }
        throw err;
      }
      if (!result) {
        throw new ToolError(
          `old_string not found in ${rawPath}, even with whitespace/indentation/escape fallbacks. ` +
            "Re-read the file and copy the text exactly (check invisible characters), or the file may have changed since you read it.",
        );
      }
      const { updated, strategy, count } = result;

      const ok = await ctx.requestPermission({
        tool: "edit",
        summary: `Edit ${rawPath} (${count === 1 ? "1 site" : `${count} sites`}${strategy !== "exact" ? `, ${strategy} match` : ""})`,
        detail: diffPreview(content, updated),
      });
      if (!ok) throw new ToolError("user declined the edit");

      await writeFile(path, usesCrlf ? updated.replace(/\n/g, "\r\n") : updated, "utf8");
      const newStat = await stat(path);
      ctx.readFileState.set(path, {
        hash: createHash("sha256").update(updated).digest("hex").slice(0, 16),
        mtimeMs: newStat.mtimeMs,
      });

      const stats = diffStats(content, updated);
      return {
        content: [
          {
            type: "text",
            text: `Edited ${rawPath}: replaced ${count === 1 ? "1 occurrence" : `${count} occurrences`} (${strategy} match)`,
          },
        ],
        display: `Edited ${rawPath} (+${stats.added} -${stats.removed})`,
        detail: diffPreview(content, updated),
        change: { path: rawPath, added: stats.added, removed: stats.removed },
      };
    },
  };
}

function stripLineNumberPrefix(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\s\s/, ""))
    .join("\n");
}

/** Added/removed line counts for the same naive walk as diffPreview. */
export function diffStats(before: string, after: string): { added: number; removed: number } {
  const b = before.split("\n");
  const a = after.split("\n");
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < b.length || j < a.length) {
    if (i < b.length && j < a.length && b[i] === a[j]) {
      i++;
      j++;
      continue;
    }
    // find resync within a small window to count real add/remove
    let look = 1;
    const maxLook = 50;
    while (look <= maxLook) {
      if (i + look < b.length && b[i + look] === a[j]) {
        removed += look;
        i += look;
        break;
      }
      if (j + look < a.length && b[i] === a[j + look]) {
        added += look;
        j += look;
        break;
      }
      look++;
    }
    if (look > maxLook) {
      removed += b.length - i;
      added += a.length - j;
      break;
    }
  }
  return { added, removed };
}

/** Small unified-diff-style preview limited to changed regions. */
export function diffPreview(before: string, after: string, maxLines = 40): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  let shown = 0;
  while ((i < beforeLines.length || j < afterLines.length) && shown < maxLines) {
    if (beforeLines[i] === afterLines[j]) {
      i++;
      j++;
      continue;
    }
    // deletion(s)
    while (i < beforeLines.length && beforeLines[i] !== afterLines[j] && shown < maxLines) {
      lines.push(`- ${beforeLines[i]}`);
      i++;
      shown++;
    }
    // insertion(s)
    while (j < afterLines.length && beforeLines[i] !== afterLines[j] && shown < maxLines) {
      lines.push(`+ ${afterLines[j]}`);
      j++;
      shown++;
    }
  }
  if (lines.length === 0) return "(no changes)";
  if (shown >= maxLines) lines.push(`… (${lines.length}+ changed lines)`);
  return lines.join("\n");
}
