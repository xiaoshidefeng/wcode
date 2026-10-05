// ls: directory listing.

import { readdir, stat } from "node:fs/promises";
import type { Tool, ToolContext, ToolOutput } from "./types.js";
import { ToolError, str } from "./types.js";
import { formatSize, resolvePath } from "./util.js";

const DESCRIPTION = `List the contents of a directory.

Usage:
- Shows each entry's size and marks directories with "/".
- Use this to explore an unfamiliar directory before reading files.`;

export function createLsTool(): Tool {
  return {
    name: "ls",
    description: DESCRIPTION,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list (default: cwd)" },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      const pathArg = args.path === undefined ? "." : str(args, "path");
      const dir = resolvePath(ctx.cwd, pathArg);
      const st = await stat(dir).catch(() => null);
      if (!st) throw new ToolError(`path not found: ${dir}`);
      if (!st.isDirectory()) throw new ToolError(`not a directory: ${dir}`);

      const entries = await readdir(dir, { withFileTypes: true });
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "(empty directory)" }], display: `ls ${pathArg}: empty` };
      }
      const sorted = [...entries].sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const lines: string[] = [];
      for (const entry of sorted.slice(0, 500)) {
        if (entry.isDirectory()) {
          lines.push(`${entry.name}/`);
        } else {
          const s = await stat(`${dir}/${entry.name}`).catch(() => null);
          lines.push(`${entry.name}  (${formatSize(s?.size ?? 0)})`);
        }
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        display: `ls ${pathArg}: ${entries.length} entries`,
      };
    },
  };
}
