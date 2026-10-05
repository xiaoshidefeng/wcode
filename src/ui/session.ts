// SessionController: session state + slash commands + agent wiring, shared by
// both frontends (plain readline fallback and the full-screen-ish TUI).
// Frontends provide I/O hooks; everything else lives here.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { AgentEvent } from "../agent/agent.js";
import { Agent } from "../agent/agent.js";
import { createTools, planModeTools, type PermissionPolicy, type ToolPolicy, type Tool } from "../tools/index.js";
import { createExitPlanTool } from "../tools/plan.js";
import { createTodoWriteTool, renderTodos, type TodoItem } from "../tools/todo.js";
import type { ToolPermissionRequest } from "../tools/types.js";
import { loadProjectInstructions, buildSystemPrompt } from "../system-prompt.js";
import { resolveModel, listModels, type ProviderRegistry } from "../config.js";
import type { ModelEntry } from "../config.js";
import { SessionStore, listSessions, loadSessionMessages } from "../session/store.js";
import type { Message, ResolvedModel } from "../types.js";
import { pruneOldToolResults, estimateTokens } from "../agent/prune.js";
import type { FileChange } from "../agent/agent.js";
import { text, userText } from "../types.js";
import { getAdapter } from "../ai/index.js";

export interface SessionOptions {
  cwd: string;
  registry: ProviderRegistry;
  model: ResolvedModel;
  policy: PermissionPolicy;
  resumeFile?: string;
  /** Start in plan mode (also: /plan or shift+tab in-session). */
  mode?: SessionMode;
}

/** Session mode (shift+tab cycles): "build" edits ask, "edit" auto-accepts file
 * edits (bash still asks), "plan" is read-only research + plan approval.
 * Claude-Code's default / accept-edits / plan trio; opencode's build/plan agents. */
export type SessionMode = "build" | "edit" | "plan";

export interface ControllerHooks {
  /** Print an already-styled line (frontend decides colors/target). */
  print(line: string): void;
  /** Render agent events (deltas, tool cards, errors). */
  onEvent(event: AgentEvent): void;
  /** Ask the user to approve a mutating action. */
  askPermission(req: ToolPermissionRequest): Promise<boolean>;
  /** Ask the user to approve a submitted plan (true = switch to build and implement). */
  askPlanApproval(req: { plan: string; planFile: string }): Promise<boolean>;
  /** Called once the controller is ready (after resume, before first prompt). */
  onReady?(): void;
}

export type LineOutcome =
  | { kind: "command" }
  | { kind: "prompt" }
  | { kind: "exit" }
  | { kind: "skip" };

export const SLASH_COMMANDS: { name: string; args?: string; description: string }[] = [
  { name: "help", description: "show this help" },
  { name: "model", args: "[provider/id]", description: "switch model (no arg = show current)" },
  { name: "models", description: "list all configured models (✓ = key available)" },
  { name: "mode", args: "[build|edit|plan]", description: "set/cycle session mode (also: shift+tab)" },
  { name: "plan", args: "[on|off]", description: "plan mode alias: read-only research + plan approval" },
  { name: "todos", description: "show the current task list" },
  { name: "clear", description: "clear the conversation" },
  { name: "compact", description: "summarize the conversation to free context" },
  { name: "prune", args: "[threshold]", description: "clear old tool outputs to free context" },
  { name: "sessions", description: "list saved sessions" },
  { name: "resume", args: "<n>", description: "load session n from /sessions" },
  { name: "yolo", description: "toggle permission prompts (ask ↔ yolo)" },
  { name: "cost", description: "token totals for this session" },
  { name: "exit", description: "quit (also: ctrl+d)" },
];

export class SessionController {
  readonly agent: Agent;
  readonly cwd: string;
  readonly registry: ProviderRegistry;
  readonly store: SessionStore;
  readonly totals = { inputTokens: 0, outputTokens: 0, cost: 0 };
  /** Input tokens of the most recent request ≈ current context size. */
  contextTokens = 0;

  private currentModel: ResolvedModel;
  private currentPolicy: PermissionPolicy;
  private currentMode: SessionMode;
  private currentTodos: TodoItem[] = [];
  private readonly tools: Tool[];
  private readonly planTools: Tool[];
  private readonly projectInstructions?: string;
  private readonly hooks: ControllerHooks;

  constructor(options: SessionOptions, hooks: ControllerHooks) {
    this.cwd = options.cwd;
    this.registry = options.registry;
    this.currentModel = options.model;
    this.currentPolicy = options.policy;
    this.currentMode = options.mode ?? "build";
    this.hooks = hooks;

    this.projectInstructions = loadProjectInstructionsSync(options.cwd);
    const tools = [
      ...createTools({
        supportsImages: (options.model.model.input ?? ["text"]).includes("image"),
        policy: options.policy,
      }),
      createTodoWriteTool((todos) => {
        this.currentTodos = todos;
        this.store.recordTodos(todos);
      }),
    ];
    this.tools = tools;
    this.planTools = planModeTools(tools, createExitPlanTool((plan) => this.handleExitPlan(plan)));
    const activeTools = this.currentMode === "plan" ? this.planTools : tools;
    this.agent = new Agent({
      cwd: options.cwd,
      model: options.model,
      system: buildSystemPrompt({
        cwd: options.cwd,
        toolNames: activeTools.map((t) => t.name),
        projectInstructions: this.projectInstructions,
        mode: this.currentMode,
      }),
      tools: activeTools,
      policy: this.effectivePolicy(),
      requestPermission: () => Promise.resolve(true), // replaced below
    });

    this.store = new SessionStore(options.cwd, options.model.key);
    this.agent.options.onMessagesChanged = (messages: Message[]) => this.store.record(messages);
    this.agent.options.requestPermission = (req) => this.hooks.askPermission(req);

    if (options.resumeFile) {
      try {
        const { messages, todos } = loadSessionMessages(options.resumeFile);
        this.agent.messages = messages;
        if (todos) this.currentTodos = todos;
        this.hooks.print(`resumed ${messages.length} messages from ${options.resumeFile}`);
      } catch (err) {
        this.hooks.print(`failed to resume: ${(err as Error).message}`);
      }
    }
    this.hooks.onReady?.();
  }

  get modelKey(): string {
    return this.currentModel.key;
  }

  get model(): ResolvedModel {
    return this.currentModel;
  }

  get policy(): PermissionPolicy {
    return this.currentPolicy;
  }

  get mode(): SessionMode {
    return this.currentMode;
  }

  get todos(): TodoItem[] {
    return this.currentTodos;
  }

  get busy(): boolean {
    return this.agent.busy;
  }

  abort(): void {
    this.agent.abort();
  }

  /** Effective runtime gate: plan (hard block) > yolo (allow all) > edit (auto-accept file edits) > ask. */
  private effectivePolicy(): ToolPolicy {
    if (this.currentMode === "plan") return "plan";
    if (this.currentPolicy === "yolo") return "yolo";
    if (this.currentMode === "edit") return "edit";
    return "ask";
  }

  togglePolicy(): PermissionPolicy {
    this.currentPolicy = this.currentPolicy === "yolo" ? "ask" : "yolo";
    this.agent.options.policy = this.effectivePolicy();
    return this.currentPolicy;
  }

  /** Switch session mode; swaps the toolset, policy gate and system prompt (next request). */
  setMode(mode: SessionMode): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    const activeTools = mode === "plan" ? this.planTools : this.tools;
    this.agent.options.tools = activeTools;
    this.agent.options.policy = this.effectivePolicy();
    this.agent.setSystem(
      buildSystemPrompt({
        cwd: this.cwd,
        toolNames: activeTools.map((t) => t.name),
        projectInstructions: this.projectInstructions,
        mode,
      }),
    );
  }

  /** shift+tab cycle: build → edit → plan → build. */
  toggleMode(): SessionMode {
    const next: SessionMode = this.currentMode === "build" ? "edit" : this.currentMode === "edit" ? "plan" : "build";
    this.setMode(next);
    return next;
  }

  /** exit_plan callback: persist the plan, ask the user, switch to build on approval. */
  private async handleExitPlan(plan: string): Promise<boolean> {
    const planFile = savePlanFile(this.cwd, plan);
    const ok = await this.hooks.askPlanApproval({ plan, planFile });
    if (ok) this.setMode("build");
    return ok;
  }

  private modeNotice(mode: SessionMode): string {
    switch (mode) {
      case "plan":
        return "plan mode on — read-only research; the agent submits its plan via exit_plan for approval (shift+tab toggles)";
      case "edit":
        return "edit mode on — file edits auto-approved, bash still asks";
      default:
        return "build mode — file edits ask for approval";
    }
  }

  clearConversation(): void {
    this.agent.messages = [];
    this.currentTodos = [];
    this.store.recordTodos([]);
  }

  /** Dispatch a user line. Slash commands return "command"; plain text returns "prompt". */
  async handleLine(line: string): Promise<LineOutcome> {
    const trimmed = line.trim();
    if (trimmed === "") return { kind: "skip" };
    // Stray y/n lines only make sense as permission answers; queued leftovers
    // (multi-line paste / piped input) must not reach the model as prompts.
    if (/^(y|yes|n|no)$/i.test(trimmed)) return { kind: "skip" };
    if (trimmed === "/exit" || trimmed === "/quit") return { kind: "exit" };

    const match = trimmed.match(/^\/([a-z]+)(?:\s+(.*))?$/i);
    if (match) {
      const [, name, arg = ""] = match;
      const handled = await this.runCommand(name!.toLowerCase(), arg!);
      return handled ? { kind: "command" } : { kind: "skip" };
    }
    return { kind: "prompt" };
  }

  private turnChanges = new Map<string, FileChange>();

  /** Run one user prompt through the agent, emitting events to the frontend. */
  async runPrompt(prompt: string): Promise<void> {
    this.turnChanges.clear();
    await this.agent.run(prompt, (event) => {
      if (event.type === "tool_end" && event.output.change && !event.isError) {
        const prev = this.turnChanges.get(event.output.change.path);
        this.turnChanges.set(event.output.change.path, {
          path: event.output.change.path,
          added: (prev?.added ?? 0) + event.output.change.added,
          removed: (prev?.removed ?? 0) + event.output.change.removed,
        });
      }
      if (event.type === "turn_end") {
        this.totals.inputTokens += event.totalUsage.inputTokens;
        this.totals.outputTokens += event.totalUsage.outputTokens;
        this.totals.cost += event.totalUsage.cost;
        this.contextTokens = event.contextTokens;
        this.hooks.onEvent({ ...event, changes: [...this.turnChanges.values()] });
        return;
      }
      this.hooks.onEvent(event);
    });
  }

  /** Slash-command completions for the given input ([] if not a slash command). */
  slashCommands(input: string): { name: string; args?: string; description: string }[] {
    if (!input.startsWith("/") || input.includes(" ")) return [];
    const partial = input.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(partial));
  }

  /**
   * Models the user actually configured: available (key resolves) or
   * belonging to a provider explicitly listed in their config file. Hides
   * built-in catalog entries that were never set up.
   */
  configuredModels(): ModelEntry[] {
    const userProviders = new Set(Object.keys(this.registry.config.providers));
    return listModels(this.registry).filter(
      (e) => e.available || userProviders.has(e.providerId),
    );
  }

  /** Switch the session model by "provider/model" selector. Returns a message. */
  switchModel(selector: string): string {
    try {
      this.currentModel = resolveModel(this.registry, selector.trim());
      this.agent.setModel(this.currentModel);
      this.store.setModel(this.currentModel.key);
      return `switched to ${this.currentModel.key}`;
    } catch (err) {
      return (err as Error).message;
    }
  }

  private async runCommand(name: string, arg: string): Promise<boolean> {
    const hooks = this.hooks;
    switch (name) {
      case "help": {
        const lines = SLASH_COMMANDS.map(
          (c) => `  /${c.name}${c.args ? " " + c.args : ""}${" ".repeat(Math.max(1, 22 - c.name.length - (c.args?.length ?? 0)))}${c.description}`,
        );
        hooks.print(lines.join("\n"));
        return true;
      }
      case "model": {
        if (arg.trim() === "") {
          hooks.print(`current model: ${this.currentModel.key}`);
          return true;
        }
        hooks.print(this.switchModel(arg));
        return true;
      }
      case "models": {
        for (const entry of this.configuredModels()) {
          const mark = entry.available ? "✓" : "✗";
          const current = entry.key === this.currentModel.key ? " ←" : "";
          hooks.print(`${mark} ${entry.key}${current}`);
        }
        return true;
      }
      case "clear": {
        this.clearConversation();
        hooks.print("conversation cleared");
        return true;
      }
      case "compact": {
        if (this.agent.messages.length === 0) {
          hooks.print("nothing to compact");
          return true;
        }
        hooks.print("compacting…");
        try {
          const summary = await summarizeConversation(this.agent.messages, this.currentModel);
          this.agent.messages = [
            userText(
              `<context_summary>\n${summary}\n</context_summary>\n\nThe conversation so far is summarized above. Continue helping the user; they may refer to details from the summary.`,
            ),
          ];
          this.store.setModel(this.currentModel.key);
          hooks.print(`compacted to ${summary.length} chars of summary`);
        } catch (err) {
          hooks.print(`compact failed: ${(err as Error).message}`);
        }
        return true;
      }
      case "sessions": {
        const sessions = listSessions();
        if (sessions.length === 0) {
          hooks.print("no saved sessions");
          return true;
        }
        sessions.slice(0, 15).forEach((s, i) => {
          hooks.print(
            `${String(i + 1).padStart(2)}  ${s.createdAt.slice(0, 16).replace("T", " ")}  ${s.model}  ${s.preview || "(empty)"}`,
          );
        });
        return true;
      }
      case "resume": {
        const sessions = listSessions();
        const idx = parseInt(arg.trim(), 10);
        if (!Number.isInteger(idx) || idx < 1 || idx > sessions.length) {
          hooks.print(`usage: /resume <n> with n in 1..${sessions.length} (see /sessions)`);
          return true;
        }
        const target = sessions[idx - 1]!;
        try {
          const { messages, todos } = loadSessionMessages(target.file);
          this.agent.messages = messages;
          this.currentTodos = todos ?? [];
          hooks.print(`resumed ${messages.length} messages from ${target.createdAt.slice(0, 16).replace("T", " ")} (${target.preview || "no preview"})`);
        } catch (err) {
          hooks.print(`failed to resume: ${(err as Error).message}`);
        }
        return true;
      }
      case "yolo": {
        const policy = this.togglePolicy();
        const note = this.currentMode === "plan" ? " (plan mode still blocks edits)" : "";
        hooks.print(policy === "yolo" ? `permission prompts disabled (yolo mode)${note}` : "permission prompts enabled");
        return true;
      }
      case "plan": {
        const want = arg.trim().toLowerCase();
        const target: SessionMode = want === "on" ? "plan" : want === "off" ? "build" : this.currentMode === "plan" ? "build" : "plan";
        if (target === this.currentMode) {
          hooks.print(target === "plan" ? "already in plan mode" : "already in build mode");
          return true;
        }
        this.setMode(target);
        hooks.print(this.modeNotice(target));
        return true;
      }
      case "mode": {
        const want = arg.trim().toLowerCase();
        const valid: SessionMode[] = ["build", "edit", "plan"];
        if (want !== "" && !valid.includes(want as SessionMode)) {
          hooks.print(`usage: /mode [build|edit|plan] (no arg cycles; current: ${this.currentMode})`);
          return true;
        }
        if (want !== "" && want === this.currentMode) {
          hooks.print(`already in ${want} mode`);
          return true;
        }
        const target: SessionMode = want !== "" ? (want as SessionMode) : this.toggleMode();
        this.setMode(target);
        hooks.print(this.modeNotice(target));
        return true;
      }
      case "todos": {
        if (this.currentTodos.length === 0) {
          hooks.print("no task list yet (the agent creates one with todo_write)");
          return true;
        }
        hooks.print(renderTodos(this.currentTodos));
        return true;
      }
      case "prune": {
        const limit = this.currentModel.model.contextWindow;
        const trigger = limit ? Math.floor(limit * 0.6) : 60_000;
        const estimated = estimateTokens(this.agent.messages);
        const pruned = pruneOldToolResults(this.agent.messages, Math.floor(trigger / 2));
        if (!pruned) {
          hooks.print(`nothing to prune (est. ${estimated} tokens, below the ${trigger}-token trigger)`);
          return true;
        }
        this.agent.messages = pruned.messages;
        hooks.print(`pruned ${pruned.prunedBlocks} old tool outputs, freed ~${Math.round(pruned.charsFreed / 1024)}KB of context`);
        return true;
      }
      case "cost": {
        const usage = this.totals;
        hooks.print(`in ${usage.inputTokens}, out ${usage.outputTokens}, ≈$${usage.cost.toFixed(4)}`);
        return true;
      }
      default:
        hooks.print(`unknown command /${name}. Try /help`);
        return true;
    }
  }
}

/** Persist a submitted plan under .wcode/plans/ (opencode keeps plan files too); returns the display path. */
function savePlanFile(cwd: string, plan: string): string {
  try {
    const dir = `${cwd}/.wcode/plans`;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(`${dir}/${stamp}.md`, `${plan}\n`, "utf8");
    return `.wcode/plans/${stamp}.md`;
  } catch {
    return "(unsaved)";
  }
}

function loadProjectInstructionsSync(cwd: string): string | undefined {  const candidates = ["WCODE.md", "AGENTS.md", "CLAUDE.md", ".wcode/instructions.md"];
  const parts: string[] = [];
  for (const name of candidates) {
    const path = `${cwd}/${name}`;
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8");
      if (content.trim() !== "") parts.push(`<file path="${name}">\n${content.trim()}\n</file>`);
    } catch {
      /* unreadable */
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Summarize the conversation via a tool-less LLM call (for /compact). */
async function summarizeConversation(messages: Message[], model: ResolvedModel): Promise<string> {
  const adapter = getAdapter(model.provider.api);
  const request = {
    system: "You are a conversation summarizer. Produce a dense summary of the conversation for continuation purposes: the user's goals, key decisions, files touched (with paths), commands run, and current state. Write in the same language as the conversation. Output only the summary.",
    messages: [
      ...messages,
      {
        role: "user" as const,
        content: [text("Summarize this conversation now, following the system instructions.")],
      },
    ],
    tools: [],
    model,
    options: { maxTokens: 8192 } as const,
  };
  let summaryText = "";
  for await (const event of adapter(request)) {
    if (event.type === "text_delta") summaryText += event.delta;
    if (event.type === "error") throw new Error(event.errorMessage);
  }
  if (summaryText.trim() === "") throw new Error("model returned an empty summary");
  return summaryText.trim();
}
