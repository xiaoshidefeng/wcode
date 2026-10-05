// The agent loop: stream a response, collect tool calls, execute them,
// feed results back, repeat until the model answers without tools.
//
// Two conventions borrowed from the references:
// - Loop exit is decided by the absence of tool_call blocks in the final
//   message, not by stop_reason alone (claude-code: "stop_reason is unreliable").
// - Tool errors become error tool_results; the loop never dies from a
//   failing tool (pi).
//
// Events are push-based (a streaming UI needs updates while awaits are in
// flight, which an async generator cannot express).

import { randomUUID } from "node:crypto";
import type { AssistantMessage, ContentBlock, Message, ResolvedModel, ToolSchema } from "../types.js";
import { text, toolResult, userText } from "../types.js";
import { getAdapter } from "../ai/index.js";
import { estimateTokens, pruneOldToolResults } from "./prune.js";
import { runTool, type ToolPolicy, type Tool } from "../tools/index.js";
import type { ToolContext, ToolOutput, ToolPermissionRequest } from "../tools/types.js";

const MAX_TURNS = 60;

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; call: ToolCall; summary: string }
  | { type: "tool_update"; callId: string; line: string }
  | { type: "tool_end"; call: ToolCall; output: ToolOutput; isError: boolean; durationMs: number }
  | { type: "message_end"; message: AssistantMessage }
  | { type: "notice"; message: string }
  | {
      type: "turn_end";
      message: AssistantMessage;
      totalUsage: UsageTotals;
      /** Input tokens of the final request (≈ current context size). */
      contextTokens: number;
      /** Dollars spent on this prompt so far. */
      cost: number;
      /** File mutations from this prompt's tools (attached by the controller). */
      changes?: FileChange[];
    }
  | { type: "error"; errorMessage: string };

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface AgentOptions {
  cwd: string;
  model: ResolvedModel;
  system: string;
  tools: Tool[];
  /** "plan" gates mutating tools off entirely (plan mode). */
  policy: ToolPolicy;
  requestPermission: (req: ToolPermissionRequest) => Promise<boolean>;
  /** Called after every message is appended (session persistence hook). */
  onMessagesChanged?: (messages: Message[]) => void;
}

interface ToolRunOutcome {
  output: ToolOutput;
  isError: boolean;
}

export class Agent {
  messages: Message[] = [];
  readonly options: AgentOptions;
  private readonly readFileState = new Map<string, { hash: string; mtimeMs: number }>();
  private abortController: AbortController | null = null;

  constructor(options: AgentOptions) {
    this.options = options;
  }

  get modelKey(): string {
    return this.options.model.key;
  }

  setModel(model: ResolvedModel): void {
    this.options.model = model;
  }

  /** Swap the system prompt (plan mode toggles rewrite it). */
  setSystem(system: string): void {
    this.options.system = system;
  }

  /** Tool schemas are derived per request so toolset swaps (plan mode) apply on the next turn. */
  private schemas(): ToolSchema[] {
    return this.options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  abort(): void {
    this.abortController?.abort();
  }

  get busy(): boolean {
    return this.abortController !== null;
  }

  /** Run one user prompt to completion; emits AgentEvents as work happens. */
  async run(prompt: string, emit: (event: AgentEvent) => void): Promise<UsageTotals> {
    this.appendMessage(userText(prompt));
    const totals: UsageTotals = { inputTokens: 0, outputTokens: 0, cost: 0 };
    let contextTokens = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Automatic prune-style compaction: when the estimated context grows
      // past 60% of the window (or 60k tokens for unknown windows), clear old
      // tool outputs except a protected recent tail.
      const window = this.options.model.model.contextWindow;
      const trigger = window ? Math.floor(window * 0.6) : 60_000;
      const estimated = estimateTokens(this.messages);
      if (estimated > trigger) {
        const pruned = pruneOldToolResults(this.messages, Math.floor(trigger / 2));
        if (pruned) {
          this.messages = pruned.messages;
          emit({
            type: "notice",
            message: `context prune: cleared ${pruned.prunedBlocks} old tool outputs (freed ~${Math.round(pruned.charsFreed / 1024)}KB)`,
          });
        }
      }
      this.abortController = new AbortController();
      const signal = this.abortController.signal;
      let final: AssistantMessage | null = null;
      try {
        const adapter = getAdapter(this.options.model.provider.api);
        const request = {
          system: this.options.system,
          messages: this.messages,
          tools: this.schemas(),
          model: this.options.model,
          options: {
            signal,
            maxTokens: this.options.model.model.maxTokens,
          },
        };
        for await (const event of adapter(request)) {
          if (event.type === "text_delta") emit({ type: "text_delta", delta: event.delta });
          else if (event.type === "thinking_delta") emit({ type: "thinking_delta", delta: event.delta });
          else if (event.type === "error") emit({ type: "error", errorMessage: event.errorMessage });
          if (event.type === "done" || event.type === "error") final = event.message;
        }
      } catch (err) {
        // Adapter failed before streaming started (bad key, bad URL, ...).
        emit({ type: "error", errorMessage: (err as Error)?.message ?? String(err) });
        this.abortController = null;
        return totals;
      } finally {
        this.abortController = null;
      }

      if (!final) {
        emit({ type: "error", errorMessage: "model returned no response" });
        return totals;
      }
      final.model = final.model ?? this.modelKey;
      totals.inputTokens += final.usage?.inputTokens ?? 0;
      totals.outputTokens += final.usage?.outputTokens ?? 0;
      contextTokens = final.usage?.inputTokens ?? contextTokens;
      totals.cost += this.turnCost(final.usage);

      const aborted = final.stopReason === "aborted";
      const truncated = final.stopReason === "length";
      // On abort/truncation drop streamed tool calls — their arguments may be
      // half-finished JSON and executing them would be unsafe.
      const calls = extractCalls(final.content, truncated || aborted);
      const cleanedContent: ContentBlock[] = final.content.filter(
        (b) => b.type !== "tool_call" || calls.some((c) => c.id === (b as { id: string }).id),
      );
      const assistantMessage: AssistantMessage = { ...final, content: cleanedContent };
      this.appendMessage({ role: "assistant", content: cleanedContent });
      emit({ type: "message_end", message: assistantMessage });

      if (aborted || (calls.length === 0 && !truncated)) {
        emit({ type: "turn_end", message: assistantMessage, totalUsage: totals, contextTokens, cost: totals.cost });
        return totals;
      }
      if (truncated && calls.length === 0) {
        this.appendMessage(
          userText(
            "[system note: your previous response hit the max output token limit and was cut off. Continue from exactly where you stopped; do not repeat earlier text.]",
          ),
        );
        continue;
      }
      if (truncated) {
        this.appendMessage({
          role: "user",
          content: calls.map((c) =>
            toolResult(c.id, [text("Error: your tool call was cut off by the max output token limit and was not executed. Re-issue it.")], true),
          ),
        });
        emit({ type: "turn_end", message: assistantMessage, totalUsage: totals, contextTokens, cost: totals.cost });
        return totals;
      }

      await this.executeCalls(calls, signal, emit);
      // next turn: the model now sees the tool results
    }

    emit({ type: "error", errorMessage: `reached the ${MAX_TURNS}-turn limit for one prompt` });
    return totals;
  }

  private async executeCalls(calls: ToolCall[], signal: AbortSignal, emit: (event: AgentEvent) => void): Promise<void> {
    const baseCtx: ToolContext = {
      cwd: this.options.cwd,
      readFileState: this.readFileState,
      requestPermission: this.options.requestPermission,
      signal,
      onUpdate: () => {},
    };
    // Mutating tools run through a serial queue in call order; read-only
    // tools start immediately and run in parallel.
    let serial: Promise<unknown> = Promise.resolve();
    const tasks = calls.map((call) => {
      const task = async (): Promise<void> => {
        const ctx: ToolContext = {
          ...baseCtx,
          onUpdate: (line) => emit({ type: "tool_update", callId: call.id, line }),
        };
        emit({ type: "tool_start", call, summary: summarizeCall(call) });
        const started = Date.now();
        const outcome = await this.runOne(call, ctx);
        emit({ type: "tool_end", call, output: outcome.output, isError: outcome.isError, durationMs: Date.now() - started });
      };
      const tool = this.options.tools.find((t) => t.name === call.name);
      if (tool && !tool.readOnly) {
        const chained = serial.then(task, task);
        serial = chained.catch(() => undefined);
        return chained;
      }
      return task();
    });
    await Promise.all(tasks);
    this.appendResults(calls);
  }

  private outcomes = new Map<string, ToolRunOutcome>();

  private appendResults(calls: ToolCall[]): void {
    const blocks: ContentBlock[] = [];
    for (const call of calls) {
      const outcome = this.outcomes.get(call.id) ?? {
        output: { content: [{ type: "text", text: "Error: tool did not produce a result" }], display: "no result" },
        isError: true,
      };
      this.outcomes.delete(call.id);
      blocks.push(toolResult(call.id, outcome.output.content, outcome.isError));
    }
    this.appendMessage({ role: "user", content: blocks });
  }

  private async runOne(call: ToolCall, ctx: ToolContext): Promise<ToolRunOutcome> {
    const argsOrError = parseArgs(call);
    const outcome: ToolRunOutcome = argsOrError.error
      ? {
          output: {
            content: [{ type: "text", text: `Error: invalid arguments for ${call.name}: ${argsOrError.error}` }],
            display: `${call.name}: invalid arguments`,
          },
          isError: true,
        }
      : await runTool(this.options.tools, call.name, argsOrError.args!, ctx, this.options.policy);
    this.outcomes.set(call.id, outcome);
    return outcome;
  }

  /** Dollars for one streamed response, from the model's $/M-token rates. */
  private turnCost(usage: AssistantMessage["usage"]): number {
    if (!usage) return 0;
    const rates = this.options.model.model.cost;
    if (!rates) return 0;
    const input = ((usage.inputTokens ?? 0) / 1e6) * (rates.input ?? 0);
    const output = ((usage.outputTokens ?? 0) / 1e6) * (rates.output ?? 0);
    return input + output;
  }

  private appendMessage(message: Message): void {
    this.messages.push(message);
    this.options.onMessagesChanged?.(this.messages);
  }
}

function summarizeCall(call: ToolCall): string {
  try {
    const args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
    if (typeof args === "object" && args !== null) {
      const record = args as Record<string, unknown>;
      if (typeof record.path === "string") return record.path;
      if (typeof record.command === "string") return record.command.length > 80 ? `${record.command.slice(0, 80)}…` : record.command;
      if (typeof record.pattern === "string") return record.pattern;
    }
  } catch {
    /* fall through */
  }
  return "";
}

function parseArgs(call: ToolCall): { args?: Record<string, unknown>; error?: string } {
  try {
    if (call.arguments.trim() === "") return { args: {} };
    const parsed = JSON.parse(call.arguments);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "arguments must be a JSON object" };
    }
    return { args: parsed as Record<string, unknown> };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export function extractCalls(content: ContentBlock[], dropAll: boolean): ToolCall[] {
  if (dropAll) return [];
  const calls: ToolCall[] = [];
  for (const block of content) {
    if (block.type !== "tool_call") continue;
    let args = block.arguments ?? "";
    if (typeof args !== "string") {
      try {
        args = JSON.stringify(args);
      } catch {
        args = "{}";
      }
    }
    calls.push({ id: block.id || `call_${randomUUID().slice(0, 8)}`, name: block.name, arguments: args });
  }
  return calls;
}
