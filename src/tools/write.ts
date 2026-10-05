// write: create or overwrite a file. Existing files must have been Read first
// (same rule as claude-code) so the agent can't clobber unseen content.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Tool, ToolContext, ToolOutput } from "./types.js";
import { ToolError, str } from "./types.js";
import { resolvePath } from "./util.js";

const DESCRIPTION = `Write a file to the local filesystem, creating parent directories as needed.

Usage:
- Overwriting an existing file requires reading it with the read tool first; otherwise the write fails.
- Prefer edit for targeted changes to existing files; use write for new files or full rewrites.
- Do not include line numbers in content.`;

export function createWriteTool(): Tool {
  return {
    name: "write",
    description: DESCRIPTION,
    readOnly: false,
    mutation: "file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory" },
        content: { type: "string", description: "Full content to write" },
      },
      required: ["path", "content"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      const rawPath = str(args, "path");
      const content = str(args, "content");
      const path = resolvePath(ctx.cwd, rawPath);

      const existing = await stat(path).catch(() => null);
      if (existing?.isDirectory()) throw new ToolError(`${path} is a directory`);
      if (existing) {
        const state = ctx.readFileState.get(path);
        if (!state) {
          throw new ToolError(`refusing to overwrite ${path}: it has not been read in this session. Read it first.`);
        }
        const current = await stat(path);
        if (current.mtimeMs !== state.mtimeMs) {
          throw new ToolError(
            `refusing to write ${path}: it was modified after the last read (maybe by another process). Read it again first.`,
          );
        }
      }
      const ok = await ctx.requestPermission({
        tool: "write",
        summary: existing ? `Overwrite ${rawPath} (${content.length} chars)` : `Create ${rawPath} (${content.length} chars)`,
      });
      if (!ok) throw new ToolError("user declined the write");

      const oldLines = existing ? (await readFile(path, "utf8")).split("\n").length : 0;

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      const st = await stat(path);
      ctx.readFileState.set(path, { hash: createHash("sha256").update(content).digest("hex").slice(0, 16), mtimeMs: st.mtimeMs });
      const lines = content.split("\n").length;
      return {
        content: [{ type: "text", text: `Wrote ${content.length} bytes to ${rawPath} (${lines} lines)` }],
        display: existing ? `Wrote ${rawPath} (overwritten, ${lines} lines)` : `Created ${rawPath} (${lines} lines)`,
        change: { path: rawPath, added: lines, removed: oldLines },
      };
    },
  };
}
