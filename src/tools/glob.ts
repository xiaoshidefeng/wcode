// glob: filename search.

import { stat } from "node:fs/promises";
import type { Tool, ToolContext, ToolOutput } from "./types.js";
import { ToolError, num, str } from "./types.js";
import { globToRegex, listFiles, resolvePath } from "./util.js";

const DESCRIPTION = `Find files whose path matches a glob pattern.

Usage:
- Patterns are relative to "path" (default: working directory), e.g. "src/**/*.ts", "*.json", "test/**/*.{js,ts}".
- ** matches any number of directories; * matches within one segment; ? matches one character; {a,b} alternation is supported.
- Returns paths sorted with most recently modified first, capped at 100 results.
- Prefer this over running find/ls via bash.`;

export function createGlobTool(): Tool {
  return {
    name: "glob",
    description: DESCRIPTION,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'Glob pattern, e.g. "src/**/*.ts"' },
        path: { type: "string", description: "Directory to search (default: cwd)" },
      },
      required: ["pattern"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      const pattern = str(args, "pattern");
      const pathArg = args.path === undefined ? "." : str(args, "path");
      const limit = Math.min(num(args, "limit") ?? 100, 500);
      const root = resolvePath(ctx.cwd, pathArg);
      const st = await stat(root).catch(() => null);
      if (!st || !st.isDirectory()) throw new ToolError(`directory not found: ${root}`);

      const regex = globToRegex(pattern.replace(/^\.\//, ""));
      const files = await listFiles(root);
      const matches: { rel: string; mtimeMs: number }[] = [];
      for (const rel of files) {
        if (regex.test(rel)) {
          const fileStat = await stat(`${root}/${rel}`).catch(() => null);
          matches.push({ rel, mtimeMs: fileStat?.mtimeMs ?? 0 });
        }
      }
      if (matches.length === 0) {
        return { content: [{ type: "text", text: "No files matched." }], display: `glob ${pattern}: no matches` };
      }
      matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const shown = matches.slice(0, limit);
      const body =
        shown.map((mo) => mo.rel).join("\n") +
        (matches.length > limit ? `\n\n[… ${matches.length - limit} more]` : "");
      return {
        content: [{ type: "text", text: body }],
        display: `glob ${pattern}: ${matches.length} file${matches.length === 1 ? "" : "s"}`,
      };
    },
  };
}
