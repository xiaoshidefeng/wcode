// read: file contents with cat -n line numbers, offset/limit pagination and
// image support for vision models.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "./types.js";
import { ToolError, num, str } from "./types.js";
import { addLineNumbers, resolvePath } from "./util.js";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_LINE_CHARS = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const DESCRIPTION = `Read a file from the local filesystem.

Usage:
- The path can be absolute or relative to the working directory.
- By default reads up to ${MAX_LINES} lines; use "offset" (0-based start line) and "limit" to page through longer files.
- Output uses cat -n style line numbers (e.g. "  42  const x = 1"). Line numbers are NOT part of the file content.
- Text output is capped at ${Math.floor(MAX_BYTES / 1024)}KB and ${MAX_LINE_CHARS} chars per line; read further ranges with offset/limit.
- The result always states whether it reached the end of the file.
- Images (png/jpg/gif/webp) are returned as images if the current model supports vision.
- You must Read a file before editing or overwriting it.`;

export function createReadTool(supportsImages: boolean): Tool {
  return {
    name: "read",
    description: DESCRIPTION,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory" },
        offset: { type: "number", description: "0-based line index to start from (0 = first line)" },
        limit: { type: "number", description: `Number of lines to read (default ${MAX_LINES})` },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      const rawPath = str(args, "path");
      const offset = Math.max(0, num(args, "offset") ?? 0); // 0-based line index
      const limit = Math.max(1, num(args, "limit") ?? MAX_LINES);
      const path = resolvePath(ctx.cwd, rawPath);

      const st = await stat(path).catch(() => null);
      if (!st) throw new ToolError(`file not found: ${path}`);
      if (st.isDirectory()) throw new ToolError(`${path} is a directory (use ls or glob to list directories)`);

      const ext = extname(path).toLowerCase();
      if (IMAGE_TYPES[ext]) {
        if (!supportsImages) {
          throw new ToolError(
            `cannot display image: the current model does not support image input. Use bash (e.g. \`file\`, \`identify\`) to inspect it.`,
          );
        }
        if (st.size > MAX_IMAGE_BYTES) throw new ToolError(`image too large (${st.size} bytes, max ${MAX_IMAGE_BYTES})`);
        const data = await readFile(path);
        return {
          content: [{ type: "image", media: { type: "base64", mediaType: IMAGE_TYPES[ext]!, data: data.toString("base64") } }],
          display: `Read image ${rawPath} (${(st.size / 1024).toFixed(0)}KB)`,
        };
      }

      const raw = await readFile(path, "utf8");
      const allLines = raw.split("\n");
      // Trailing empty element from a trailing newline is not a real line.
      if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
      const total = allLines.length;

      let start = offset;
      let end = Math.min(start + limit, total);
      if (start >= total && total > 0) {
        throw new ToolError(`offset ${offset} is beyond end of file (${total} lines total)`);
      }
      let selected = allLines.slice(start, end);
      selected = selected.map((line) =>
        line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… (line truncated to ${MAX_LINE_CHARS} chars)` : line,
      );
      while (Buffer.byteLength(selected.join("\n"), "utf8") > MAX_BYTES && selected.length > 1) {
        selected.pop();
      }
      end = start + selected.length;

      const content = addLineNumbers(selected, start + 1);
      const marker =
        end < total
          ? `\n\n[Showing lines ${start + 1}-${end} of ${total}. Use offset=${end} to continue reading.]`
          : `\n\n[End of file — total ${total} line${total === 1 ? "" : "s"}]`;
      ctx.readFileState.set(path, { hash: contentHash(raw), mtimeMs: st.mtimeMs });
      return {
        content: [{ type: "text", text: content + marker }],
        display: `Read ${rawPath}${start > 0 ? ` (from line ${start + 1})` : ""}: ${selected.length} of ${total} lines`,
      };
    },
  };
}

function contentHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
