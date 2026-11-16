// SessionController: session state + slash commands + agent wiring, shared by
// both frontends (plain readline fallback and the full-screen-ish TUI).
// Frontends provide I/O hooks; everything else lives here.

import { existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, watch, type FSWatcher } from "node:fs";
import type { AgentEvent } from "../agent/agent.js";
import { Agent } from "../agent/agent.js";
import { createTools, planModeTools, type PermissionPolicy, type ToolPolicy, type Tool } from "../tools/index.js";
import { createExitPlanTool } from "../tools/plan.js";
import { createTodoWriteTool, renderTodos, type TodoItem } from "../tools/todo.js";
import { createTaskTool } from "../tools/task.js";
import type { ToolPermissionRequest } from "../tools/types.js";
import { loadProjectInstructions, buildSystemPrompt } from "../system-prompt.js";
import { resolveModel, listModels, loadRegistry, CONFIG_DIR, CONFIG_PATH, type ProviderRegistry } from "../config.js";
import type { ModelEntry } from "../config.js";
import { loadSettings, saveThemeSetting } from "../settings.js";
import { applyTheme, listThemes, activeThemeName } from "./theme.js";
import { stripJsonComments } from "../jsonc.js";
import { PermissionGate, formatRule } from "../permissions.js";
import { loadCustomCommands, findCustomCommand, expandCommand, type CustomCommand } from "../commands.js";
import { loadMcpServers, McpRegistry } from "../mcp/index.js";
import { SessionStore, listSessions, loadSessionMessages, type SessionSummary } from "../session/store.js";
import { generateSessionTitle } from "../session/title.js";
import type { Message, ResolvedModel } from "../types.js";
import { pruneOldToolResults, estimateTokens } from "../agent/prune.js";
import { compactMessages } from "../agent/compact.js";
import type { FileChange } from "../agent/agent.js";
import { text, userText } from "../types.js";
import { resolve } from "node:path";

export interface SessionOptions {
  cwd: string;
  registry: ProviderRegistry;
  model: ResolvedModel;
  policy: PermissionPolicy;
  resumeFile?: string;
  /** Start in plan mode (also: /plan or shift+tab in-session). */
  mode?: SessionMode;
  /** First prompt to run on launch (`wcode "fix the failing test"`). */
  initialPrompt?: string;
  /** Extra permission rules from --allowed-tools / --disallowed-tools. */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Text appended verbatim to the system prompt (--append-system-prompt). */
  appendSystemPrompt?: string;
}

/** Session mode (shift+tab cycles): "build" edits ask, "edit" auto-accepts file
 * edits (bash still asks), "plan" is read-only research + plan approval.
 * Claude-Code's default / accept-edits / plan trio; opencode's build/plan agents. */
export type SessionMode = "build" | "edit" | "plan";

/** Answer to a permission prompt: "always" also adds a rule for the call. */
export type PermissionAnswer = "yes" | "always" | "no";

export type ToastKind = "info" | "success" | "warning" | "error";

/** Keyboard/prefix shortcuts, shared by /help (plain) and the TUI "?" panel. */
export const SHORTCUTS: [string, string][] = [
  ["enter", "send message (while busy: steer into the running prompt)"],
  ["alt+enter", "queue the message for after the current prompt"],
  ["shift+tab", "cycle mode: build → edit → plan"],
  ["ctrl+j", "insert newline (backslash+enter also works)"],
  ["↑ / ↓", "input history · move in multi-line input"],
  ["esc esc", "interrupt the agent (press twice within 5s)"],
  ["esc", "dismiss menus"],
  ["ctrl+p", "command palette (fuzzy-search every command)"],
  ["ctrl+o", "compose the current input in $EDITOR"],
  ["ctrl+c", "clear input · again when empty: quit"],
  ["ctrl+d", "quit (empty input)"],
  ["ctrl+l", "clear the screen (conversation kept)"],
  ["ctrl+u / ctrl+k", "clear line before / after cursor"],
  ["ctrl+w", "delete word before cursor"],
  ["! cmd", "run a shell command yourself; output joins the context"],
  ["# note", "append a note to WCODE.md project memory"],
  ["/ …", "slash commands · @ file paths"],
];

export interface ControllerHooks {
  /** Print an already-styled line (frontend decides colors/target). */
  print(line: string): void;
  /** Render agent events (deltas, tool cards, errors). */
  onEvent(event: AgentEvent): void;
  /** Ask the user to approve a mutating action ("always" adds a rule). */
  askPermission(req: ToolPermissionRequest): Promise<PermissionAnswer>;
  /** Ask the user to approve a submitted plan (true = switch to build and implement). */
  askPlanApproval(req: { plan: string; planFile: string }): Promise<boolean>;
  /** Transient notification (toast in the TUI, printed line in plain mode). */
  toast?(text: string, kind?: ToastKind): void;
  /** A session title was set (the TUI updates its window title). */
  onTitle?(title: string): void;
  /** Called once the controller is ready (after resume, before first prompt). */
  onReady?(): void;
}

export type LineOutcome =
  | { kind: "command" }
  | { kind: "prompt"; promptText?: string }
  | { kind: "exit" }
  | { kind: "skip" };

export const SLASH_COMMANDS: { name: string; args?: string; description: string }[] = [
  { name: "help", description: "show this help" },
  { name: "model", args: "[provider/id]", description: "switch model (no arg = show current)" },
  { name: "models", description: "list all configured models (✓ = key available)" },
  { name: "mode", args: "[build|edit|plan]", description: "set/cycle session mode (also: shift+tab)" },
  { name: "plan", args: "[on|off]", description: "plan mode alias: read-only research + plan approval" },
  { name: "init", description: "analyze the repo and write a WCODE.md project guide" },
  { name: "todos", description: "show the current task list" },
  { name: "clear", description: "clear the conversation" },
  { name: "compact", description: "summarize the conversation to free context" },
  { name: "prune", args: "[threshold]", description: "clear old tool outputs to free context" },
  { name: "rewind", args: "[n]", description: "list user turns; /rewind <n> rolls back to turn n" },
  { name: "export", args: "[file]", description: "save the transcript as markdown" },
  { name: "status", description: "session, config, permissions and MCP status" },
  { name: "sessions", description: "list saved sessions" },
  { name: "resume", args: "<n>", description: "load session n from /sessions" },
  { name: "theme", args: "[name]", description: "switch color theme (no arg: interactive picker)" },
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
  private readonly baseTools: Tool[];
  private readonly projectInstructions?: string;
  private readonly hooks: ControllerHooks;
  readonly gate: PermissionGate;
  readonly settingsPaths: string[];
  /** Theme saved in settings (undefined = auto-detect), read at startup. */
  readonly themeSetting?: string;
  private mcp: McpRegistry | null = null;
  /** Resume outcome, surfaced by the frontend after the banner (not before). */
  resumeNotice = "";
  /** "! cmd" runs one at a time (the agent may be busy at the same time). */
  private shellBusy = false;
  /** CLI flag rules — re-applied on every settings hot reload. */
  private readonly cliAllow: string[];
  private readonly cliDeny: string[];
  private watchers: FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(options: SessionOptions, hooks: ControllerHooks) {
    this.cwd = options.cwd;
    this.registry = options.registry;
    this.currentModel = options.model;
    this.currentPolicy = options.policy;
    this.currentMode = options.mode ?? "build";
    this.hooks = hooks;

    this.projectInstructions = loadProjectInstructionsSync(options.cwd);
    const settings = loadSettings(options.cwd);
    this.settingsPaths = settings.paths;
    this.themeSetting = settings.theme ?? undefined;
    // Parse failures are surfaced, never swallowed (settings.ts collects them).
    for (const warning of settings.warnings) this.hooks.print(`warning: ${warning}`);
    this.cliAllow = options.allowedTools ?? [];
    this.cliDeny = options.disallowedTools ?? [];
    this.gate = new PermissionGate(
      [...settings.settings.allow, ...(options.allowedTools ?? [])],
      [...settings.settings.deny, ...(options.disallowedTools ?? [])],
    );
    this.baseTools = [
      ...createTools({
        supportsImages: (options.model.model.input ?? ["text"]).includes("image"),
        policy: options.policy,
      }),
      createTodoWriteTool((todos) => {
        this.currentTodos = todos;
        this.store.recordTodos(todos);
      }),
    ];
    this.baseTools.push(
      createTaskTool({
        cwd: options.cwd,
        model: () => this.currentModel,
        effectivePolicy: () => this.effectivePolicy(),
        requestPermission: (req) => this.requestPermissionWithRules(req),
        gate: () => this.gate,
        baseTools: () => this.baseTools,
      }),
    );
    this.tools = [...this.baseTools];
    this.planTools = planModeTools(this.tools, createExitPlanTool((plan) => this.handleExitPlan(plan)));
    const activeTools = this.currentMode === "plan" ? this.planTools : this.tools;
    this.agent = new Agent({
      cwd: options.cwd,
      model: options.model,
      system: this.buildPrompt(activeTools),
      tools: activeTools,
      policy: this.effectivePolicy(),
      gate: this.gate, // empty gate decides "ask" everywhere — same as absent
      requestPermission: () => Promise.resolve(true), // replaced below
    });

    this.store = new SessionStore(options.cwd, options.model.key);
    this.agent.options.onMessagesChanged = (messages: Message[]) => this.store.record(messages);
    this.agent.options.onMessagesReplaced = (messages: Message[]) => this.store.rewrite(messages);
    this.agent.options.requestPermission = (req) => this.requestPermissionWithRules(req);

    if (options.resumeFile) {
      try {
        const { messages, todos, title } = loadSessionMessages(options.resumeFile);
        this.agent.messages = messages;
        if (todos) this.currentTodos = todos;
        this.resumeNotice = `welcome back · resumed ${messages.length} messages from ${options.resumeFile}`;
        if (title !== undefined) {
          // The new session file carries the old title forward.
          this.store.setTitle(title);
          this.titleDone = true;
          this.hooks.onTitle?.(title);
        }
      } catch (err) {
        this.resumeNotice = `failed to resume: ${(err as Error).message}`;
      }
    }
    this.startMcp();
    this.startConfigWatch();
    this.hooks.onReady?.();
  }

  private buildPrompt(activeTools: Tool[]): string {
    return buildSystemPrompt({
      cwd: this.cwd,
      toolNames: activeTools.map((t) => t.name),
      projectInstructions: this.projectInstructions,
      mode: this.currentMode,
      append: this.appendSystemPrompt,
    });
  }

  private appendSystemPrompt?: string;
  /** --append-system-prompt: appended to every system prompt rebuild. */
  setAppendSystemPrompt(text: string): void {
    this.appendSystemPrompt = text;
    this.agent.setSystem(this.buildPrompt(this.agent.options.tools));
  }

  /** Connect MCP servers in the background; their tools join the next turn. */
  private startMcp(): void {
    const entries = loadMcpServers(this.cwd, this.registry);
    if (entries.length === 0) return;
    this.mcp = new McpRegistry(entries);
    void this.mcp.start().then(() => {
      const mcpTools = this.mcp!.tools();
      const statuses = this.mcp!.status();
      const failed = statuses.filter((s) => !s.connected);
      if (mcpTools.length > 0) {
        this.baseTools.push(...mcpTools);
        this.refreshToolsets();
      }
      const parts: string[] = [];
      if (mcpTools.length > 0) {
        parts.push(`${mcpTools.length} tool${mcpTools.length === 1 ? "" : "s"} from ${statuses.filter((s) => s.connected).map((s) => s.name).join(", ")}`);
      }
      for (const f of failed) parts.push(`${f.name} failed: ${f.error}`);
      if (parts.length > 0) this.hooks.print(`mcp: ${parts.join(" · ")}`);
    });
  }

  /** Recompute toolsets + system prompt after the tool list changes (MCP join). */
  private refreshToolsets(): void {
    this.tools.length = 0;
    this.tools.push(...this.baseTools);
    const exitPlan = createExitPlanTool((plan) => this.handleExitPlan(plan));
    this.planTools.length = 0;
    this.planTools.push(...planModeTools(this.tools, exitPlan));
    this.agent.options.tools = this.currentMode === "plan" ? this.planTools : this.tools;
    this.agent.setSystem(this.buildPrompt(this.agent.options.tools));
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

  /** Kill MCP children and drop file watchers before process exit. */
  shutdown(): void {
    this.mcp?.close();
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  // ----- config hot reload (opencode watches config; wcode watches the four
  // files that shape a session: config.json, both settings.json, .mcp.json) --

  private startConfigWatch(): void {
    const arm = (dir: string, onEvent: (filename: string) => void): void => {
      try {
        const w = watch(dir, { persistent: false }, (_event, filename) => {
          if (filename) onEvent(filename);
        });
        this.watchers.push(w);
      } catch {
        /* directory missing — nothing to watch */
      }
    };
    arm(CONFIG_DIR, (filename) => {
      if (filename === "config.json" || filename === "settings.json") this.scheduleReload();
    });
    arm(this.cwd, (filename) => {
      if (filename === ".mcp.json") this.scheduleReload();
      if (filename === ".wcode") {
        // The dir just appeared (often right before its first settings.json
        // write) — arm the inner watcher and reload what's already there.
        this.armProjectSettingsWatch();
        this.scheduleReload();
      }
    });
    this.armProjectSettingsWatch();
  }

  /** The project .wcode/ dir may not exist at startup — arm lazily. */
  private projectSettingsWatcher: FSWatcher | null = null;
  private armProjectSettingsWatch(): void {
    if (this.projectSettingsWatcher) return;
    try {
      this.projectSettingsWatcher = watch(`${this.cwd}/.wcode`, { persistent: false }, (_event, filename) => {
        if (filename === "settings.json") this.scheduleReload();
      });
      this.watchers.push(this.projectSettingsWatcher);
    } catch {
      this.projectSettingsWatcher = null; // created later — the cwd watcher re-arms
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    // Editors replace files atomically; 100ms coalesces the event burst.
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.reloadConfig();
    }, 100);
  }

  private reloadConfig(): void {
    try {
      const settings = loadSettings(this.cwd);
      this.gate.replace(
        [...settings.settings.allow, ...this.cliAllow],
        [...settings.settings.deny, ...this.cliDeny],
      );
      // Providers re-merge; keep the current model if it still resolves.
      const fresh = loadRegistry();
      this.registry.config = fresh.config;
      this.registry.providers = fresh.providers;
      try {
        this.currentModel = resolveModel(this.registry, this.currentModel.key);
      } catch {
        this.currentModel = resolveModel(this.registry);
      }
      this.agent.setModel(this.currentModel);
      const msg = `config reloaded · ${this.currentModel.key}`;
      if (this.hooks.toast) this.hooks.toast(msg, "info");
      else this.hooks.print(msg);
    } catch (err) {
      const msg = `config reload failed: ${(err as Error).message}`;
      if (this.hooks.toast) this.hooks.toast(msg, "error");
      else this.hooks.print(msg);
    }
  }

  // ----- mid-run submissions (steer + queue) --------------------------------

  /** Lines submitted while the agent works. Steers join the running prompt at
   * the next turn boundary (agent.steer, opencode's inbox); queued ones run
   * after the current prompt finishes. */
  private pending: { text: string; deliver: "steer" | "queue" }[] = [];

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Route a line submitted mid-run. Plain text steers into the running prompt;
   * commands (`/`, `!`, `#`) and rejected steers wait in the queue.
   */
  submitWhileBusy(text: string, deliver: "steer" | "queue" = "steer"): "steered" | "queued" {
    const isPrompt = !/^[!#/]/.test(text.trimStart());
    if (deliver === "steer" && isPrompt && this.agent.steer(text)) return "steered";
    this.pending.push({ text, deliver });
    return "queued";
  }

  /** Take and clear the post-run queue (drained by the frontend). */
  drainPending(): string[] {
    return this.pending.splice(0).map((p) => p.text);
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
    this.agent.setSystem(this.buildPrompt(activeTools));
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

  /** Forward to the UI prompt; "always allow" additionally records a rule. */
  private async requestPermissionWithRules(req: ToolPermissionRequest): Promise<boolean> {
    const ans = await this.hooks.askPermission(req);
    if (ans === "always" && req.subject !== undefined) this.addAllowRule(req.tool, req.subject);
    return ans !== "no";
  }

  /**
   * "always allow" from the permission prompt: derive a rule from the call's
   * subject (bash → its first word, e.g. `bash(npm *)`; other tools → exact
   * subject) and persist it in the project settings so future sessions skip
   * the ask too.
   */
  private addAllowRule(tool: string, subject: string): void {
    const rule = tool === "bash" ? `${tool}(${subject.split(/\s+/)[0]!} *)` : `${tool}(${subject})`;
    this.gate.addAllow(rule);
    const settingsPath = `${this.cwd}/.wcode/settings.json`;
    try {
      let raw: { permissions?: { allow?: string[]; deny?: string[] } } = {};
      if (existsSync(settingsPath)) {
        raw = JSON.parse(stripJsonComments(readFileSync(settingsPath, "utf8")));
      }
      const allow = raw.permissions?.allow ?? [];
      if (!allow.includes(rule)) allow.push(rule);
      raw.permissions = { ...raw.permissions, allow };
      mkdirSync(`${this.cwd}/.wcode`, { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
      const msg = `rule saved to ${settingsPath}: ${rule}`;
      if (this.hooks.toast) this.hooks.toast(msg, "success");
      else this.hooks.print(msg);
    } catch (err) {
      this.hooks.print(`rule active for this session, but saving failed: ${(err as Error).message}`);
    }
  }

  /**
   * "! cmd" (bang mode): run the command directly — the user typed it, so no
   * permission ask — show the output, and add command + output to the
   * conversation context so the model can reason about it next turn.
   */
  async runShellPassthrough(cmd: string): Promise<void> {
    if (this.shellBusy) {
      this.hooks.print("a ! command is already running");
      return;
    }
    const bash = this.tools.find((t) => t.name === "bash");
    if (!bash) {
      this.hooks.print("bash tool unavailable");
      return;
    }
    this.shellBusy = true;
    try {
      const out = await bash.execute(
        { command: cmd },
        {
          cwd: this.cwd,
          readFileState: new Map(),
          requestPermission: async () => true,
          onUpdate: (line) => this.hooks.onEvent({ type: "tool_update", callId: "bang", line }),
        },
      );
      const fullText = out.content.find((c): c is { type: "text"; text: string } => c.type === "text")?.text ?? "";
      const status = /\[(exit code -?\d+|timed out[^\]]*)\]\s*$/.exec(fullText)?.[1];
      const lines = [out.display];
      if (out.detail) for (const l of out.detail.split("\n").slice(0, 40)) lines.push(`  ${l}`);
      if (status && status !== "exit code 0") lines.push(`(${status})`);
      this.hooks.print(lines.join("\n"));
      // command + output join the context as a user message
      this.agent.messages.push(
        userText(
          `<bash-input>${cmd}</bash-input>\n<bash-status>${status ?? "exit code 0"}</bash-status>\n<bash-output>\n${fullText}\n</bash-output>`,
        ),
      );
      this.store.record(this.agent.messages);
    } catch (err) {
      this.hooks.print(`! ${cmd} failed: ${(err as Error).message}`);
    } finally {
      this.shellBusy = false;
    }
  }

  /** "# note": append a memory line to the project's WCODE.md. */
  private appendMemoryNote(note: string): void {
    const path = `${this.cwd}/WCODE.md`;
    try {
      if (!existsSync(path)) writeFileSync(path, "# Project memory\n\n", "utf8");
      appendFileSync(path, `- ${note}\n`, "utf8");
      this.hooks.print(`memory: added to ${path}`);
    } catch (err) {
      this.hooks.print(`memory: failed to write ${path}: ${(err as Error).message}`);
    }
  }

  /** Dispatch a user line. Slash commands return "command"; plain text returns "prompt". */
  async handleLine(line: string): Promise<LineOutcome> {
    const trimmed = line.trim();
    if (trimmed === "") return { kind: "skip" };
    // Stray y/n/a lines only make sense as permission answers; queued leftovers
    // (multi-line paste / piped input) must not reach the model as prompts.
    if (/^(y|yes|a|always|n|no)$/i.test(trimmed)) return { kind: "skip" };
    if (trimmed === "/exit" || trimmed === "/quit") return { kind: "exit" };
    // "! cmd": run a shell command directly; output joins the context.
    if (trimmed.startsWith("!")) {
      const cmd = trimmed.slice(1).trim();
      if (cmd === "") {
        this.hooks.print("usage: ! <shell command> — output is shown and added to the conversation context");
        return { kind: "command" };
      }
      await this.runShellPassthrough(cmd);
      return { kind: "command" };
    }
    // "# note": append to the project memory file (WCODE.md).
    if (trimmed.startsWith("#")) {
      const note = trimmed.slice(1).trim();
      if (note === "") {
        this.hooks.print("usage: # <note> — appends a line to WCODE.md project memory");
        return { kind: "command" };
      }
      this.appendMemoryNote(note);
      return { kind: "command" };
    }

    const match = trimmed.match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i);
    if (match) {
      const [, name, arg = ""] = match;
      const handled = await this.runCommand(name!.toLowerCase(), arg!);
      if (handled) return { kind: "command" };
      // Not a builtin — a custom command template?
      const custom = findCustomCommand(this.cwd, name!);
      if (custom) {
        return { kind: "prompt", promptText: expandCommand(custom, arg!) };
      }
      // "/tmp", "~/docs", "/usr/local" — a path that exists is a prompt, not
      // a mistyped command (slash triggers only for known commands otherwise).
      if (existsSync(resolve(this.cwd, trimmed))) return { kind: "prompt" };
      this.hooks.print(`unknown command /${name}. Try /help`);
      return { kind: "skip" };
    }
    return { kind: "prompt" };
  }

  private turnChanges = new Map<string, FileChange>();

  /** Run one user prompt through the agent, emitting events to the frontend. */
  async runPrompt(prompt: string): Promise<void> {
    await this.runPromptText(prompt);
  }

  private async runPromptText(promptText: string): Promise<void> {
    this.turnChanges.clear();
    // Auto-compact (reserve trigger) and overflow recovery live inside the
    // agent loop now, so print mode gets them too; the store rewrite is wired
    // through AgentOptions.onMessagesReplaced.
    await this.agent.run(promptText, (event) => {
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
    void this.maybeGenerateTitle();
  }

  private titleDone = false;

  /** After the first exchange, name the session (one-shot; silent on failure). */
  private async maybeGenerateTitle(): Promise<void> {
    if (this.titleDone) return;
    const hasReply = this.agent.messages.some(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text.trim() !== ""),
    );
    if (!hasReply) return;
    this.titleDone = true;
    const title = await generateSessionTitle(this.agent.messages, this.currentModel);
    if (!title) return;
    this.store.setTitle(title);
    this.hooks.onTitle?.(title);
    this.hooks.toast?.(`session title: ${title}`, "info");
  }

  /** Slash-command completions for the given input ([] if not a slash command). */
  slashCommands(input: string): { name: string; args?: string; description: string }[] {
    if (!input.startsWith("/") || input.includes(" ")) return [];
    const partial = input.slice(1).toLowerCase();
    const builtin = SLASH_COMMANDS.filter((c) => c.name.startsWith(partial)).map((c) => ({ ...c }));
    const custom = loadCustomCommands(this.cwd)
      .filter((c) => c.name.startsWith(partial) && !SLASH_COMMANDS.some((b) => b.name === c.name))
      .map((c) => ({
        name: c.name,
        args: c.argumentHint ?? "[args]",
        description: c.source === "project" ? `${c.description} · project command` : `${c.description} · command`,
      }));
    return [...builtin, ...custom];
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

  /** /theme [name]: switch the color theme and persist it (user settings). */
  switchTheme(name: string): string {
    const trimmed = name.trim();
    if (trimmed === "") {
      return `theme: ${activeThemeName()} · available: ${listThemes().map((t) => t.name).join(", ")} — /theme <name> to switch`;
    }
    if (!applyTheme(trimmed)) {
      return `unknown theme "${trimmed}" — available: ${listThemes().map((t) => t.name).join(", ")}`;
    }
    try {
      saveThemeSetting(trimmed);
    } catch (err) {
      return `theme applied, but saving failed: ${(err as Error).message}`;
    }
    this.hooks.toast?.(`theme: ${trimmed}`, "success");
    return `theme switched to ${trimmed}`;
  }

  /** Load a saved session's transcript into the agent (returns a message). */
  resumeSession(target: SessionSummary): string {
    try {
      const { messages, todos } = loadSessionMessages(target.file);
      this.agent.messages = messages;
      this.currentTodos = todos ?? [];
      return `resumed ${messages.length} messages from ${target.createdAt.slice(0, 16).replace("T", " ")} (${target.title ?? (target.preview || "no preview")})`;
    } catch (err) {
      return `failed to resume: ${(err as Error).message}`;
    }
  }

  /** User text turns, last-first, for /rewind: 1 = most recent. */
  private userTurns(): { index: number; text: string; messageIdx: number }[] {
    const out: { index: number; text: string; messageIdx: number }[] = [];
    this.agent.messages.forEach((msg, messageIdx) => {
      if (msg.role !== "user") return;
      const first = msg.content.find((b): b is { type: "text"; text: string } => b.type === "text");
      if (!first || first.text.startsWith("<context_summary>")) return;
      // tool results are user-role too; only plain single-text blocks are turns
      if (msg.content.some((b) => b.type === "tool_result")) return;
      out.push({ index: out.length + 1, text: first.text, messageIdx });
    });
    return out;
  }

  /** /rewind: list turns, or roll the conversation back to before turn n. */
  private rewind(arg: string): string {
    const turns = this.userTurns();
    if (turns.length === 0) return "no user turns to rewind";
    if (arg === "") {
      const lines = turns
        .slice(-10)
        .reverse()
        .map((t) => `${String(t.index).padStart(2)}  ${t.text.replace(/\n/g, " ").slice(0, 90)}`);
      return [`recent turns (newest first):`, ...lines, ``, `roll back with /rewind <n> — drops everything from that turn on.`].join("\n");
    }
    const n = parseInt(arg, 10);
    const target = turns.find((t) => t.index === n);
    if (!target) return `no turn ${arg} (valid: 1..${turns.length}, newest = 1)`;
    this.agent.messages = this.agent.messages.slice(0, target.messageIdx);
    this.currentTodos = [];
    this.store.rewrite(this.agent.messages);
    this.store.recordTodos([]);
    const removed = turns.filter((t) => t.index >= n).length;
    return `rewound to turn ${n}: removed ${removed} later turn${removed === 1 ? "" : "s"} (files on disk are untouched)`;
  }

  private statusReport(): string {
    const lines: string[] = [];
    const ctx = this.currentModel.model.contextWindow;
    const pct = ctx ? ` (${Math.round((this.contextTokens / ctx) * 100)}% of window)` : "";
    lines.push(`model     ${this.currentModel.key}${ctx ? ` · ${Math.round(ctx / 1000)}k window` : ""}`);
    lines.push(`context   ${this.contextTokens} tokens${pct}`);
    lines.push(`mode      ${this.currentMode} · policy ${this.currentPolicy}${this.gate.isEmpty ? "" : " · permission rules active"}`);
    lines.push(`cwd       ${this.cwd}`);
    lines.push(`config    ${this.registry.configPath}`);
    for (const p of this.settingsPaths) lines.push(`settings  ${p}`);
    if (this.projectInstructions) lines.push(`instructions  WCODE.md/AGENTS.md/CLAUDE.md loaded`);
    const mcp = this.mcp?.status() ?? [];
    if (mcp.length > 0) {
      for (const s of mcp) {
        lines.push(`mcp       ${s.connected ? "✓" : "✗"} ${s.name} · ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"} · ${s.source}${s.error ? ` · ${s.error}` : ""}`);
      }
    } else {
      lines.push(`mcp       (none configured — .mcp.json or config.json mcpServers)`);
    }
    const commands = loadCustomCommands(this.cwd);
    if (commands.length > 0) lines.push(`commands  ${commands.map((c) => `/${c.name}`).join(" ")}`);
    return lines.join("\n");
  }

  private async runCommand(name: string, arg: string): Promise<boolean> {
    const hooks = this.hooks;
    switch (name) {
      case "help": {
        const lines = SLASH_COMMANDS.map(
          (c) => `  /${c.name}${c.args ? " " + c.args : ""}${" ".repeat(Math.max(1, 22 - c.name.length - (c.args?.length ?? 0)))}${c.description}`,
        );
        const custom = loadCustomCommands(this.cwd);
        if (custom.length > 0) {
          lines.push("", "custom commands:");
          for (const c of custom) {
            lines.push(`  /${c.name}${c.argumentHint ? " " + c.argumentHint : ""}${" ".repeat(Math.max(1, 22 - c.name.length - (c.argumentHint?.length ?? 0)))}${c.description}`);
          }
        }
        lines.push("", "shortcuts:");
        for (const [key, desc] of SHORTCUTS) lines.push(`  ${key.padEnd(16)}${desc}`);
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
          // Summary + the most recent exchanges kept verbatim (compact.ts v2).
          const compacted = await compactMessages(this.agent.messages, this.currentModel);
          this.agent.messages = compacted;
          this.store.rewrite(compacted);
          hooks.print(`compacted to ${compacted.length} messages (summary + recent turns)`);
        } catch (err) {
          hooks.print(`compact failed: ${(err as Error).message}`);
        }
        return true;
      }
      case "init": {
        hooks.print("> /init");
        await this.runPromptText(initPromptText(this.cwd, this.projectInstructions));
        return true;
      }
      case "export": {
        hooks.print(exportTranscript(this.cwd, this.agent.messages, arg.trim()));
        return true;
      }
      case "rewind": {
        hooks.print(this.rewind(arg.trim()));
        return true;
      }
      case "status": {
        hooks.print(this.statusReport());
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
            `${String(i + 1).padStart(2)}  ${s.createdAt.slice(0, 16).replace("T", " ")}  ${s.model}  ${s.title ?? (s.preview || "(empty)")}`,
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
        hooks.print(this.resumeSession(sessions[idx - 1]!));
        return true;
      }
      case "theme": {
        hooks.print(this.switchTheme(arg));
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
        // Not a builtin — handleLine tries custom commands next.
        return false;
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

/** /init: the repo-analysis prompt (claude-code init-style). */
function initPromptText(cwd: string, instructions?: string): string {
  const existing = instructions ? `\n\nA project instructions file already exists and is loaded in your context. Improve it: fix anything stale or missing, keep it concise.` : "";
  return [
    `Analyze this repository (${cwd}) and write a WCODE.md file at the repo root that orients a coding agent working here.`,
    ``,
    `Do this:`,
    `1. Survey the repo: package manifests, build/test configuration, directory layout, README, entry points. Use read/glob/grep/ls; run nothing that mutates.`,
    `2. Write WCODE.md with: what the project is and its main technologies; the essential commands (install / build / test / lint, exactly as they must be run); architecture overview of the important directories and files; any non-obvious conventions, gotchas, or environment requirements.`,
    `3. Keep it under ~60 lines: dense, factual, no marketing. Only include commands you actually verified exist in manifests/config.`,
    `4. Do not commit anything.${existing}`,
    ``,
    `When done, print the file's contents.`,
  ].join("\n");
}

/** /export: transcript → markdown file. Returns a display message. */
function exportTranscript(cwd: string, messages: Message[], target: string): string {
  const lines: string[] = [`# wcode transcript`, ``, `- exported: ${new Date().toISOString()}`, ``];
  let turn = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      const blocks = msg.content;
      if (blocks.some((b) => b.type === "tool_result")) {
        continue; // tool noise stays out of the export
      }
      const t = blocks.find((b): b is { type: "text"; text: string } => b.type === "text");
      if (!t || t.text.startsWith("<context_summary>")) continue;
      turn++;
      lines.push(`## turn ${turn} — user`, ``, t.text, ``);
    } else {
      const parts: string[] = [];
      for (const b of msg.content) {
        if (b.type === "text" && b.text.trim() !== "") parts.push(b.text);
        else if (b.type === "tool_call") {
          let summary = "";
          try {
            const parsed = JSON.parse(b.arguments || "{}") as Record<string, unknown>;
            summary = String(parsed.command ?? parsed.path ?? parsed.query ?? parsed.description ?? "");
          } catch {
            /* keep empty */
          }
          parts.push(`> ${b.name}${summary ? `: ${summary}` : ""}`);
        }
      }
      if (parts.length > 0) lines.push(`**assistant**`, ``, parts.join("\n\n"), ``);
    }
  }
  const path = target === "" ? `wcode-export-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md` : target;
  const full = path.startsWith("/") ? path : `${cwd}/${path}`;
  try {
    writeFileSync(full, lines.join("\n"), "utf8");
    return `transcript exported to ${full}`;
  } catch (err) {
    return `export failed: ${(err as Error).message}`;
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
