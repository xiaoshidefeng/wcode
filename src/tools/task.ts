// task: delegate focused work to a subagent with its own context window.
// The subagent's transcript is thrown away — only its final report returns to
// the parent conversation, keeping exploration noise out of the main context.
//
// Subagent types (claude-code workflow):
//   explore — read-only research (read/grep/glob/ls/web); parallel-safe,
//             no permission prompts, forced in plan mode.
//   general — full toolbox except task (no recursion); mutations inside
//             still go through the parent's permission flow.

import type { AgentEvent } from "../agent/agent.js";
import { Agent } from "../agent/agent.js";
import type { ResolvedModel } from "../types.js";
import type { Tool, ToolContext, ToolOutput } from "./types.js";
import { ToolError, str } from "./types.js";
import type { ToolPolicy } from "./index.js";

export type SubagentType = "explore" | "general";

export interface TaskToolOptions {
  /** Resolved on each call so /model switches apply to new subagents. */
  model: () => ResolvedModel;
  /** Live parent policy (plan hard-blocks, yolo silences prompts...). */
  effectivePolicy: () => ToolPolicy;
  /** Parent permission hook — general subagent mutations still ask. */
  requestPermission: ToolContext["requestPermission"];
  /** Parent's gate so deny rules hold inside subagents too. */
  gate?: () => import("../permissions.js").PermissionGate | undefined;
  cwd: string;
  /** Full base toolset minus task (read/write/edit/bash/grep/glob/ls/web...). */
  baseTools: () => Tool[];
}

const EXPLORE_TOOLS = new Set(["read", "grep", "glob", "ls", "webfetch", "websearch"]);

// A stalled subagent must never hold the parent's Promise.all forever: one
// hung stream in a parallel batch used to freeze the whole session with no
// output. The watchdog aborts the subagent; the report (if any) still lands,
// flagged as partial. WCODE_TASK_TIMEOUT_MS overrides; 0 disables.
const TASK_TIMEOUT_MS = Number(process.env.WCODE_TASK_TIMEOUT_MS) || 15 * 60_000;
// Thinking/retry stretches emit no events — surface aliveness on this cadence.
const TASK_HEARTBEAT_MS = Number(process.env.WCODE_TASK_HEARTBEAT_MS) || 15_000;

function subagentSystem(cwd: string, type: SubagentType): string {
  const kind =
    type === "explore"
      ? [
          `You are a read-only research subagent. Investigate and report — you cannot modify anything.`,
          `Be efficient: read only what the task needs. Prefer grep/glob to locate, read to confirm.`,
        ]
      : [
          `You are a general-purpose subagent. Complete the given task fully using your tools.`,
          `File edits and commands may prompt the user for approval; keep calls minimal and purposeful.`,
        ];
  return [
    `You are a wcode subagent dispatched by the main agent. Work autonomously — there is no one to talk to; never ask questions, just do the work and report.`,
    ...kind,
    ``,
    `# Rules`,
    `- Stay strictly on the assigned task. Do not touch unrelated files.`,
    `- Your final message is the deliverable: end with a dense, self-contained report (findings, exact file paths and line numbers, what you changed or verified). The parent agent sees ONLY this report, not your tool output.`,
    `- Working directory: ${cwd}`,
  ].join("\n");
}

export function createTaskTool(opts: TaskToolOptions): Tool {
  return {
    name: "task",
    description: `Delegate a focused subtask to a subagent with its own context window. Use for broad exploration (finding where something lives, surveying many files) or self-contained chunks of work; the subagent's tool output stays in its own context and only its final report returns.

- subagent_type "explore" (default): read-only research — fast, parallel-safe, never asks permission. Use it to gather file paths, line numbers, and facts before editing.
- subagent_type "general": full toolbox (edits, bash) for self-contained jobs; write actions still ask the user.
- The prompt must be a complete, standalone brief: context, exact goal, expected output. Subagents don't see the parent conversation.
- Do not use task for trivial one-file lookups — just use read/grep directly.`,
    readOnly: true, // the dispatch itself mutates nothing; "general" mutations prompt inside
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "A 3-5 word summary of the subtask" },
        prompt: { type: "string", description: "The complete task brief for the subagent (it sees no other context)" },
        subagent_type: { type: "string", enum: ["explore", "general"], description: 'Subagent kind, default "explore"' },
      },
      required: ["description", "prompt"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      const description = str(args, "description");
      const prompt = str(args, "prompt").trim();
      if (prompt === "") throw new ToolError("prompt must not be empty");
      const requested = str(args, "subagent_type", "explore");
      if (requested !== "explore" && requested !== "general") {
        throw new ToolError(`unknown subagent_type "${requested}" (explore | general)`);
      }
      // Plan mode may never reach a writing subagent, whatever the model asks.
      const type: SubagentType = opts.effectivePolicy() === "plan" ? "explore" : requested;

      const base = opts.baseTools().filter((t) => t.name !== "task");
      const tools = type === "explore" ? base.filter((t) => EXPLORE_TOOLS.has(t.name)) : base;
      const model = opts.model();
      const sub = new Agent({
        cwd: opts.cwd,
        model,
        system: subagentSystem(opts.cwd, type),
        tools,
        policy: opts.effectivePolicy(),
        gate: opts.gate?.(),
        requestPermission: opts.requestPermission,
      });
      // Parent interrupt propagates to the subagent loop.
      const forwardAbort = () => sub.abort();
      ctx.signal?.addEventListener("abort", forwardAbort, { once: true });

      // Live progress: subagent activity streams to the parent's UI as
      // tool_update lines (the TUI spinner shows the latest; print mode
      // prints them). Without this a parallel batch of tasks looks frozen
      // between dispatch and report — the "silent plan mode" problem.
      const label = `task(${type}): ${description}`;
      const startedAt = Date.now();
      let lastActivity = Date.now();
      // An error event always terminates the subagent loop — remember it so a
      // partially-streamed answer can't pass as the final report below.
      let failedWithError: string | null = null;
      const onEvent = (event: AgentEvent): void => {
        let line: string | null = null;
        if (event.type === "tool_start") {
          line = `${event.call.name}${event.summary ? ` ${event.summary.slice(0, 60)}` : ""}`;
        } else if (event.type === "notice") {
          line = event.message; // subagent retries/prunes were invisible before
        } else if (event.type === "error") {
          failedWithError = event.errorMessage;
          line = `error: ${event.errorMessage}`;
        }
        if (line !== null) {
          lastActivity = Date.now();
          ctx.onUpdate?.(`${label} · ${line}`);
        }
      };
      // Heartbeat: long thinking/retry stretches emit nothing at all — state
      // that explicitly so silence is diagnosable, not just invisible.
      const heartbeat = setInterval(() => {
        const quietS = Math.round((Date.now() - lastActivity) / 1000);
        ctx.onUpdate?.(`${label} · ${Math.round((Date.now() - startedAt) / 1000)}s in, ${quietS}s quiet (thinking or waiting on the provider)`);
      }, TASK_HEARTBEAT_MS);
      // Watchdog: abort a runaway/stalled subagent so the parent's turn can
      // finish and the post-run queue can drain.
      let timedOut = false;
      const watchdog =
        TASK_TIMEOUT_MS > 0
          ? setTimeout(() => {
              timedOut = true;
              sub.abort();
            }, TASK_TIMEOUT_MS)
          : null;
      try {
        await sub.run(prompt, onEvent);
      } finally {
        if (watchdog) clearTimeout(watchdog);
        clearInterval(heartbeat);
        ctx.signal?.removeEventListener("abort", forwardAbort);
      }
      let report = lastAssistantText(sub.messages);
      // A subagent that died mid-run (stream error, parent interrupt) may
      // still have streamed partial text — returning that as the "report"
      // would silently feed garbage to the parent. Only a clean stop or a
      // watchdog timeout counts as a deliverable.
      if (!timedOut && failedWithError !== null) {
        throw new ToolError(`subagent failed before reporting: ${failedWithError}`);
      }
      if (report === undefined) {
        throw new ToolError(
          timedOut
            ? `${label} timed out after ${Math.round(TASK_TIMEOUT_MS / 1000)}s without a report`
            : "subagent finished without a report (it may have been interrupted)",
        );
      }
      if (timedOut) {
        report += `\n\n[system note: the subagent hit the ${Math.round(TASK_TIMEOUT_MS / 1000)}s timeout and was aborted; this report may be partial.]`;
      }
      return {
        content: [{ type: "text", text: report }],
        display: label,
      };
    },
  };
}

function lastAssistantText(messages: { role: string; content: { type: string; text?: string }[] }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    const texts = msg.content.filter((b) => b.type === "text" && (b.text ?? "").trim() !== "");
    const joined = texts.map((b) => b.text!.trim()).join("\n\n");
    if (joined !== "") return joined;
  }
  return undefined;
}
