// grep: content search. Prefers the system ripgrep when available (fast,
// gitignore-aware), falls back to a pure-Node walker otherwise.

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "./types.js";
import { ToolError, bool, num, str } from "./types.js";
import { listFiles, resolvePath, truncateOutput, globToRegex } from "./util.js";

const MAX_RESULTS = 200;

const TEXT_EXTS = new Set([
  "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".css", ".scss", ".html",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php",
  ".sh", ".bash", ".zsh", ".fish", ".sql", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".xml",
  ".vue", ".svelte", ".astro", ".proto", ".graphql", ".env", ".gitignore", ".dockerfile", ".makefile",
]);

const DESCRIPTION = `Search file contents with a regular expression.

Usage:
- Pattern uses Rust regex syntax (ripgrep) or JS regex in fallback mode; both accept typical patterns like "foo.*bar", "^def ", "\\berror\\b".
- "path" limits the search to a file or directory (default: working directory).
- "glob" filters searched files, e.g. "*.ts" or "*.{js,jsx}".
- Output is "path:line: text" with a cap on matches; refine the pattern rather than re-running broadly.
- Prefer this over running grep/rg via bash.`;

export function createGrepTool(): Tool {
  return {
    name: "grep",
    description: DESCRIPTION,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "File or directory to search (default: cwd)" },
        glob: { type: "string", description: "Filename filter, e.g. \"*.ts\"" },
        ignore_case: { type: "boolean", description: "Case-insensitive search" },
        context: { type: "number", description: "Lines of context around each match (default 0)" },
      },
      required: ["pattern"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      const pattern = str(args, "pattern");
      const pathArg = args.path === undefined ? "." : str(args, "path");
      const glob = args.glob === undefined ? undefined : str(args, "glob");
      const ignoreCase = bool(args, "ignore_case");
      const context = Math.min(Math.max(0, num(args, "context") ?? 0), 5);
      const target = resolvePath(ctx.cwd, pathArg);
      const st = await stat(target).catch(() => null);
      if (!st) throw new ToolError(`path not found: ${target}`);

      if (await hasRipgrep()) {
        const out = await runRipgrep({ pattern, target, glob, ignoreCase, context });
        return finish(out, "ripgrep");
      }
      const out = await fallbackSearch({ pattern, target, glob, ignoreCase, context, isDir: st.isDirectory() });
      return finish(out, "builtin");
    },
  };
}

function finish(text: string, engine: string): ToolOutput {
  if (text.trim() === "") {
    return { content: [{ type: "text", text: "No matches found." }], display: "grep: no matches" };
  }
  const body = truncateOutput(text, 20_000);
  return {
    content: [{ type: "text", text: body }],
    display: `grep: ${body.split("\n").length} matching lines`,
  };
}

async function hasRipgrep(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("rg", ["--version"], (err) => resolve(!err));
  });
}

function runRipgrep(opts: {
  pattern: string;
  target: string;
  glob?: string;
  ignoreCase: boolean;
  context: number;
}): Promise<string> {
  const args = [
    "-n",
    "--no-heading",
    "--max-count=5",
    `--max-columns=300`,
    "--color=never",
    ...(opts.ignoreCase ? ["-i"] : []),
    ...(opts.context > 0 ? ["-C", String(opts.context)] : []),
    ...(opts.glob ? ["-g", opts.glob] : []),
    opts.pattern,
    opts.target,
  ];
  return new Promise((resolve) => {
    execFile("rg", args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && (err as any).code !== 1 ? `rg failed: ${err.message}` : stdout.toString());
    });
  });
}

async function fallbackSearch(opts: {
  pattern: string;
  target: string;
  glob?: string;
  ignoreCase: boolean;
  context: number;
  isDir: boolean;
}): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(opts.pattern, opts.ignoreCase ? "i" : "");
  } catch (err) {
    throw new ToolError(`invalid pattern: ${(err as Error).message}`);
  }
  const globRe = opts.glob ? globFilter(opts.glob) : null;
  const files = opts.isDir ? await listFiles(opts.target) : [""];
  const out: string[] = [];
  for (const rel of files) {
    if (out.length >= MAX_RESULTS) break;
    if (globRe && !globRe.test(rel.split("/").pop() ?? rel)) continue;
    if (!isProbablyText(rel)) continue;
    let content: string;
    try {
      const buf = await readFile(resolvePath(opts.target, rel));
      if (buf.byteLength > 1024 * 1024) continue;
      content = buf.toString("utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && out.length < MAX_RESULTS; i++) {
      if (regex.test(lines[i]!)) {
        if (opts.context > 0) {
          const from = Math.max(0, i - opts.context);
          const to = Math.min(lines.length, i + opts.context + 1);
          for (let k = from; k < to; k++) out.push(`${rel}:${k + 1}${k === i ? ": " : "- "}${lines[k]}`);
          out.push("--");
        } else {
          out.push(`${rel}:${i + 1}: ${lines[i]}`);
        }
      }
    }
  }
  return out.join("\n");
}

function globFilter(glob: string): RegExp | null {
  return globToRegex(glob.includes("/") ? glob : `**/${glob}`);
}

function isProbablyText(rel: string): boolean {
  return TEXT_EXTS.has(extname(rel).toLowerCase());
}
