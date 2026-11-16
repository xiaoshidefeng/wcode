// Plain readline frontend — used when stdin/stdout are not a TTY (piped
// input, scripts, tests). The TTY experience lives in tui.ts.

import readline from "node:readline";
import type { AgentEvent } from "../agent/agent.js";
import type { SessionOptions } from "./session.js";
import { SessionController, type PermissionAnswer } from "./session.js";
import { style, clearLine } from "./render.js";
import { fg } from "./render.js";
import { initTheme } from "./theme.js";
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
  initTheme(controller.themeSetting);
  if (controller.resumeNotice !== "") console.log(style.dim(controller.resumeNotice));

  function askPermission(req: ToolPermissionRequest): Promise<PermissionAnswer> {
    const summary = req.summary.length > 120 ? `${req.summary.slice(0, 120)}…` : req.summary;
    return askAnswer(
      `${fg.yellow(`? ${req.tool}: ${summary}`)} ${fg.yellow("[y] yes / [a] always / [N] no")}`,
      style.dim(`[permission denied: ${req.tool}: ${summary}]`),
    );
  }

  async function askPlanApproval(req: { plan: string; planFile: string }): Promise<boolean> {
    console.log(`${fg.magenta("⏸ plan ready for review")} ${style.dim(`· ${req.planFile}`)}`);
    const lines = req.plan.split("\n");
    for (const line of lines.slice(0, 14)) console.log(style.dim(`  │ ${line}`));
    if (lines.length > 14) console.log(style.dim("  │ …"));
    const ans = await askAnswer(
      `${fg.magenta("approve this plan?")} ${fg.yellow("[y] start implementing / [N] keep planning")}`,
      style.dim("plan kept — still in plan mode"),
    );
    return ans !== "no";
  }

  /** Shared queued prompt: only a queued y/a/n answers; other lines are deferred; no user = decline. */
  function askAnswer(question: string, denyLine: string): Promise<PermissionAnswer> {
    const toAnswer = (s: string): PermissionAnswer | null => {
      const t = s.trim().toLowerCase();
      if (t === "y" || t === "yes") return "yes";
      if (t === "a" || t === "always") return "always";
      if (t === "n" || t === "no" || t === "") return "no";
      return null;
    };
    const queuedIdx = lineQueue.findIndex((l) => toAnswer(l) !== null);
    if (queuedIdx !== -1) {
      const ans = toAnswer(lineQueue.splice(queuedIdx, 1)[0]!)!;
      if (ans === "no") console.log(denyLine);
      return Promise.resolve(ans);
    }
    if (stdinClosed) {
      console.log(style.dim(`[no user attached — denied] ${denyLine}`));
      return Promise.resolve("no");
    }
    // Interactive non-TTY oddity: ask via readline.
    return new Promise((resolve) => {
      console.log(question);
      const wait = () => {
        const queued = lineQueue.shift();
        if (queued !== undefined) {
          const ans = toAnswer(queued);
          if (ans === null) {
            lineQueue.unshift(queued); // not an answer — back to the input queue
          } else if (ans === "no") {
            console.log(denyLine);
          }
          resolve(ans ?? "no");
          return;
        }
        pendingLine = (line: string) => {
          pendingLine = null;
          const ans = toAnswer(line);
          if (ans === null) {
            lineQueue.push(line);
            wait();
            return;
          }
          if (ans === "no") console.log(denyLine);
          resolve(ans);
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
    // EOF (piped script finished, ctrl+d): never abort work in flight — the
    // current run finishes and the loop below breaks on the closed stdin.
    // Interrupting stays the job of esc/ctrl+c (SIGINT).
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

  // `wcode "task"` runs the CLI prompt before the interactive loop.
  if (options.initialPrompt !== undefined && options.initialPrompt.trim() !== "") {
    const initial = options.initialPrompt.trim();
    const outcome = await controller.handleLine(initial);
    if (outcome.kind === "prompt") await controller.runPrompt(outcome.promptText ?? initial);
  }

  while (true) {
    rl.resume();
    const line = await ask();
    if (line === "" && stdinClosed) break;
    const outcome = await controller.handleLine(line);
    if (outcome.kind === "exit") {
      exiting = true;
      break;
    }
    if (outcome.kind === "prompt") await controller.runPrompt(outcome.promptText ?? line.trim());
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
          if (process.stdout.isTTY) console.log(fg.green(`⏺ ${event.call.name} ${event.summary}`.trimEnd()));
          break;
        case "tool_end":
          if (process.stdout.isTTY) {
            clearLine();
            console.log(event.isError ? `  ${fg.red("⎿")} ${fg.red(event.output.display || "failed")}` : `  ${style.dim("⎿")} ${style.dim(event.output.display || "(no output)")}`);
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
