// Plain readline frontend — used when stdin/stdout are not a TTY (piped
// input, scripts, tests). The TTY experience lives in tui.ts.

import readline from "node:readline";
import type { AgentEvent } from "../agent/agent.js";
import type { SessionOptions } from "./session.js";
import { SessionController } from "./session.js";
import { style, clearLine } from "./render.js";
import { fg } from "./render.js";
import type { ToolPermissionRequest } from "../tools/types.js";

export async function runPlainSession(options: SessionOptions): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: fg.cyan("> "),
    terminal: process.stdout.isTTY,
  });

  const print = (line: string) => console.log(line);
  let exiting = false;
  let stdinClosed = false;
  const lineQueue: string[] = [];
  let pendingLine: ((line: string) => void) | null = null;

  const controller = new SessionController(options, {
    print,
    onEvent: plainEventHandler(),
    askPermission: (req) => askPermission(req),
    askPlanApproval: (req) => askPlanApproval(req),
  });

  function askPermission(req: ToolPermissionRequest): Promise<boolean> {
    const summary = req.summary.length > 120 ? `${req.summary.slice(0, 120)}…` : req.summary;
    return askYesNo(
      `${fg.yellow(`? ${req.tool}: ${summary}`)} ${fg.yellow("[y/N]")}`,
      style.dim(`[permission denied: ${req.tool}: ${summary}]`),
    );
  }

  function askPlanApproval(req: { plan: string; planFile: string }): Promise<boolean> {
    console.log(`${fg.magenta("⏸ plan ready for review")} ${style.dim(`· ${req.planFile}`)}`);
    const lines = req.plan.split("\n");
    for (const line of lines.slice(0, 14)) console.log(style.dim(`  │ ${line}`));
    if (lines.length > 14) console.log(style.dim("  │ …"));
    return askYesNo(
      `${fg.magenta("approve this plan?")} ${fg.yellow("[y] start implementing / [N] keep planning")}`,
      style.dim("plan kept — still in plan mode"),
    );
  }

  /** Shared queued y/N: only a queued y/n answers; other lines are deferred; no user = decline. */
  function askYesNo(question: string, denyLine: string): Promise<boolean> {
    const isAnswer = (s: string) => /^(y|yes|n|no)?$/i.test(s.trim());
    const queuedIdx = lineQueue.findIndex((l) => isAnswer(l));
    if (queuedIdx !== -1) {
      const answer = lineQueue.splice(queuedIdx, 1)[0]!.trim().toLowerCase();
      const ok = answer === "y" || answer === "yes";
      if (!ok) console.log(denyLine);
      return Promise.resolve(ok);
    }
    if (stdinClosed) {
      console.log(style.dim(`[no user attached — denied] ${denyLine}`));
      return Promise.resolve(false);
    }
    // Interactive non-TTY oddity: ask via readline.
    return new Promise((resolve) => {
      console.log(question);
      const wait = () => {
        const queued = lineQueue.shift();
        if (queued !== undefined) {
          const ok = /^(y|yes)$/i.test(queued.trim());
          if (!ok) console.log(denyLine);
          resolve(ok);
          return;
        }
        pendingLine = (line: string) => {
          pendingLine = null;
          if (!isAnswer(line)) {
            lineQueue.push(line);
            wait();
            return;
          }
          const ok = /^(y|yes)$/i.test(line.trim());
          if (!ok) console.log(denyLine);
          resolve(ok);
        };
      };
      wait();
    });
  }

  rl.on("line", (line: string) => {
    if (pendingLine) {
      const resolve = pendingLine;
      pendingLine = null;
      resolve(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on("close", () => {
    stdinClosed = true;
    // EOF while lines are still queued (e.g. a trailing /exit) means the user
    // expects the run to finish — abort only when nothing is pending.
    if (controller.busy && lineQueue.length === 0) controller.abort();
    if (pendingLine) {
      const resolve = pendingLine;
      pendingLine = null;
      resolve("");
    }
  });
  rl.on("SIGINT", () => {
    if (controller.busy) controller.abort();
    else process.exit(0);
  });

  const ask = (): Promise<string> =>
    new Promise((resolve) => {
      const queued = lineQueue.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      if (stdinClosed) {
        resolve("");
        return;
      }
      rl.prompt();
      pendingLine = resolve;
    });

  while (true) {
    rl.resume();
    const line = await ask();
    if (line === "" && stdinClosed) break;
    const outcome = await controller.handleLine(line);
    if (outcome.kind === "exit") {
      exiting = true;
      break;
    }
    if (outcome.kind === "prompt") await controller.runPrompt(line.trim());
  }
  rl.close();
  if (exiting) console.log(style.dim("bye"));

  function plainEventHandler() {
    // Minimal, grep-friendly rendering for non-TTY use.
    let lastWasText = false;
    const newlineIfNeeded = () => {
      if (lastWasText) {
        process.stdout.write("\n");
        lastWasText = false;
      }
    };
    return (event: AgentEvent) => {
      switch (event.type) {
        case "text_delta":
          process.stdout.write(event.delta);
          lastWasText = true;
          break;
        case "thinking_delta":
          process.stderr.write(style.dim(event.delta));
          break;
        case "tool_start":
          newlineIfNeeded();
          if (process.stdout.isTTY) console.log(fg.cyan(`● ${event.call.name} ${event.summary}`.trimEnd()));
          break;
        case "tool_end":
          if (process.stdout.isTTY) {
            clearLine();
            console.log(`  ${event.isError ? fg.red("✗") : fg.green("✓")} ${event.call.name}`);
          }
          break;
        case "error":
          newlineIfNeeded();
          console.error(fg.red(`error: ${event.errorMessage}`));
          process.exitCode = 1;
          break;
        case "notice":
          newlineIfNeeded();
          console.log(style.dim(event.message));
          break;
        case "turn_end": {
          newlineIfNeeded();
          if (event.changes && event.changes.length > 0) {
            const parts = event.changes.map((c) => `${c.path} (+${c.added} -${c.removed})`);
            console.log(style.dim(`Changed ${event.changes.length} file${event.changes.length === 1 ? "" : "s"}: ${parts.join(", ")}`));
          }
          if (!process.stdout.isTTY) process.stdout.write("\n");
          break;
        }
        default:
          break;
      }
    };
  }
}
