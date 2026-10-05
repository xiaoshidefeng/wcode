// bash: run a shell command with timeout and output capping.

import { spawn } from "node:child_process";
import os from "node:os";
import type { Tool, ToolContext, ToolOutput } from "./types.js";
import { ToolError, num, str } from "./types.js";
import { truncateOutput } from "./util.js";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;

const DESCRIPTION = `Run a shell command and return its combined output.

Usage:
- Runs in the working directory with the user's default shell (bash/zsh).
- Output (stdout+stderr) is capped; very long output shows head and tail.
- Non-zero exit codes return the output as an error along with the exit status.
- Default timeout 120s, max ${MAX_BASH_TIMEOUT_MS / 1000}s. Prefer a smaller timeout for quick commands.
- For long-running dev servers, prefer moving them to the background yourself (e.g. \`nohup cmd > log 2>&1 &\`) rather than waiting.
- Avoid commands that require interactivity. Pipes and redirection work fine.`;

export function createBashTool(defaultTimeoutMs = DEFAULT_BASH_TIMEOUT_MS): Tool {
  return {
    name: "bash",
    description: DESCRIPTION,
    readOnly: false,
    mutation: "shell",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        timeout: { type: "number", description: `Timeout in milliseconds (default ${defaultTimeoutMs}, max ${MAX_BASH_TIMEOUT_MS})` },
      },
      required: ["command"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      const command = str(args, "command");
      const timeout = Math.min(num(args, "timeout") ?? defaultTimeoutMs, MAX_BASH_TIMEOUT_MS);
      if (command.trim() === "") throw new ToolError("empty command");

      const ok = await ctx.requestPermission({
        tool: "bash",
        summary: command.length > 120 ? `${command.slice(0, 120)}…` : command,
      });
      if (!ok) throw new ToolError("user declined to run this command");

      const shell = process.env.SHELL && process.env.SHELL !== "" ? process.env.SHELL : "/bin/bash";
      const child = spawn(shell, ["-c", command], {
        cwd: ctx.cwd,
        detached: true, // own process group so we can kill the whole tree
        env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      const append = (chunk: Buffer) => {
        const s = chunk.toString();
        output += s;
        if (output.length > 200_000) output = output.slice(-100_000);
        const lastLine = s.split("\n").filter((l) => l.trim() !== "").pop();
        if (lastLine) ctx.onUpdate?.(lastLine.slice(0, 200));
      };
      child.stdout!.on("data", append);
      child.stderr!.on("data", append);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 2000);
      }, timeout);

      if (ctx.signal) {
        const abort = () => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        ctx.signal.addEventListener("abort", abort, { once: true });
      }

      const code: number | null = await new Promise((resolve) => {
        child.on("close", (c) => resolve(c));
        child.on("error", () => resolve(-1));
      });
      clearTimeout(timer);

      const exitInfo = timedOut ? `timed out after ${Math.round(timeout / 1000)}s` : `exit code ${code}`;
      const text = truncateOutput(output.trimEnd());
      const isError = timedOut || (code !== null && code !== 0);
      let body = text === "" ? `(no output)` : text;
      // When the output was actually truncated, persist the full text and tell
      // the model where to find it (opencode-style).
      if (text !== "" && text !== output.trimEnd()) {
        const saved = `${os.tmpdir()}/wcode-output-${Date.now()}.txt`;
        try {
          const fs = await import("node:fs/promises");
          await fs.writeFile(saved, output, "utf8");
          body += `\n\n[Output truncated. Full output saved to: ${saved}]`;
        } catch {
          /* best effort */
        }
      }
      return {
        content: [{ type: "text", text: `${body}\n\n[${exitInfo}]` }],
        display: `$ ${command.length > 100 ? `${command.slice(0, 100)}…` : command}`,
        detail: text === "" ? undefined : truncateOutput(output, 2000),
      };
    },
  };
}
