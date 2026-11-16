// wcode CLI entry: argument parsing, interactive and print modes.

import { resolve } from "node:path";
import { loadRegistry, resolveModel, listModels, ensureDirs, saveProviderApiKey, CONFIG_PATH } from "./config.js";
import { createTools } from "./tools/index.js";
import type { PermissionPolicy } from "./tools/index.js";
import { createTaskTool } from "./tools/task.js";
import { buildSystemPrompt, loadProjectInstructions } from "./system-prompt.js";
import { Agent } from "./agent/agent.js";
import { PermissionGate } from "./permissions.js";
import { loadSettings } from "./settings.js";
import { findCustomCommand, expandCommand } from "./commands.js";
import { McpRegistry, loadMcpServers } from "./mcp/index.js";
import { runPlainSession } from "./ui/plain.js";
import { runTuiSession } from "./ui/tui.js";
import { fg, style, formatDuration } from "./ui/render.js";
import { listSessions } from "./session/store.js";
import type { AgentEvent } from "./agent/agent.js";

interface Args {
  prompt?: string;
  print: boolean;
  model?: string;
  yolo: boolean;
  plan: boolean;
  edit: boolean;
  resume?: string;
  help: boolean;
  version: boolean;
  plain: boolean;
  allowedTools?: string;
  disallowedTools?: string;
  outputFormat: "text" | "json";
  appendSystemPrompt?: string;
  positional: string[];
}

import { VERSION } from "./version.js";

const HELP = `
${style.bold("wcode")} — a coding agent CLI with pluggable model providers

${style.bold("usage")}
  wcode                          interactive session
  wcode "fix the failing test"   interactive session, starts on the task
  wcode -p "explain Makefile"    one-shot: answer and exit
  wcode <command>

${style.bold("commands")}
  models              list configured models (availability from API keys)
  key <provider> <k>  save an API key for a provider into ${CONFIG_PATH}
  sessions            list saved sessions
  help                this help

${style.bold("options")}
  -p, --print         non-interactive: print the answer and exit
      --output-format <text|json>
                      print-mode output; json prints {result, model, cost, ...}
      --append-system-prompt <text>
                      extra instructions appended to the system prompt
      --allowed-tools <rules>
                      comma-separated allow rules, e.g. "bash(git *),read"
      --disallowed-tools <rules>
                      comma-separated deny rules, e.g. "bash(rm -rf *)"
  -m, --model <sel>   model selector "provider/model" (default from config)
      --yolo          skip permission prompts (also: /yolo in session)
      --edit          start in edit mode: file edits auto-approved, bash still
                      asks (also: /mode or shift+tab in session)
      --plan          start in plan mode: read-only research, the agent submits
                      a plan for your approval before editing (also: /plan,
                      shift+tab in session)
      --plain         simple readline UI instead of the full-screen TUI
  -c, --continue      resume the most recent session in this directory
  -r, --resume <n>    resume session n (see: wcode sessions)
      --version
  -h, --help

${style.bold("configuration")}
  ${CONFIG_PATH} — define custom providers/models and mcpServers:

    {
      "defaultModel": "zhipu/glm-4.6",
      "providers": {
        "zhipu": {
          "api": "openai-completions",
          "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
          "apiKey": "\${ZHIPU_API_KEY}",
          "models": [{ "id": "glm-4.6", "contextWindow": 200000, "maxTokens": 128000 }]
        }
      },
      "mcpServers": {
        "fetch": { "command": "npx", "args": ["-y", "mcp-server-fetch"] }
      }
    }

  apiKey supports "\${ENV}" variables and "!cmd -x" command output.
  Built-ins (anthropic, openai, zhipu, deepseek, moonshot, dashscope,
  openrouter, google, ollama) can be overridden or extended by id.

  Permission rules live in ~/.wcode/settings.json and .wcode/settings.json
  (permissions.allow / permissions.deny, e.g. ["bash(git *)", "bash(rm -rf *)"]).
  Custom slash commands: .wcode/commands/*.md (project) and
  ~/.wcode/commands/*.md (user) with $ARGUMENTS substitution.
`.trim();

function parseArgs(argv: string[]): Args {
  const args: Args = { print: false, yolo: false, plan: false, edit: false, help: false, version: false, plain: false, outputFormat: "text", positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-p" || a === "--print") args.print = true;
    else if (a === "--yolo") args.yolo = true;
    else if (a === "--plan") args.plan = true;
    else if (a === "--edit") args.edit = true;
    else if (a === "--plain") args.plain = true;
    else if (a === "--allowed-tools") args.allowedTools = argv[++i];
    else if (a === "--disallowed-tools") args.disallowedTools = argv[++i];
    else if (a === "--output-format") {
      const v = argv[++i];
      if (v !== "text" && v !== "json") throw new UserError(`--output-format must be "text" or "json", got "${v}"`);
      args.outputFormat = v;
    } else if (a === "--append-system-prompt") args.appendSystemPrompt = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--version") args.version = true;
    else if (a === "-m" || a === "--model") args.model = argv[++i];
    else if (a === "-c" || a === "--continue") args.resume = "latest";
    else if (a === "-r" || a === "--resume") args.resume = argv[++i] ?? "latest";
    else if (a === "--") args.positional.push(...argv.slice(i + 1)), (i = argv.length);
    else if (a.startsWith("-")) {
      throw new UserError(`unknown option ${a}\n\n${HELP}`);
    } else args.positional.push(a);
  }
  return args;
}

class UserError extends Error {}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UserError) {
      console.error(fg.red((err as Error).message));
      return 2;
    }
    throw err;
  }

  if (args.version) {
    console.log(VERSION);
    return 0;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const [command, ...rest] = args.positional;
  if (command === "models") return cmdModels();
  if (command === "key") return cmdKey(rest);
  if (command === "sessions") return cmdSessions();
  if (command === "help") {
    console.log(HELP);
    return 0;
  }

  ensureDirs();
  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    console.error(fg.red((err as Error).message));
    return 2;
  }

  let model;
  try {
    model = resolveModel(registry, args.model);
  } catch (err) {
    console.error(fg.red((err as Error).message));
    return 2;
  }

  const policy: PermissionPolicy = args.yolo ? "yolo" : "ask";
  const cwd = process.cwd();
  const prompt = args.positional.join(" ") || undefined;

  if (args.print) {
    if (prompt === undefined) {
      console.error(fg.red("print mode (-p) needs a prompt, e.g. wcode -p \"summarize this repo\""));
      return 2;
    }
    return runPrint({
      prompt,
      cwd,
      model,
      policy,
      registry,
      allowedTools: args.allowedTools?.split(",").map((s) => s.trim()).filter((s) => s !== ""),
      disallowedTools: args.disallowedTools?.split(",").map((s) => s.trim()).filter((s) => s !== ""),
      outputFormat: args.outputFormat,
      appendSystemPrompt: args.appendSystemPrompt,
    });
  }

  let resumeFile: string | undefined;
  if (args.resume !== undefined) {
    const sessions = listSessions().filter((s) => s.cwd === cwd);
    const target =
      args.resume === "latest" ? sessions[0] : sessions[parseInt(args.resume, 10) - 1];
    if (!target) {
      console.error(fg.red(args.resume === "latest" ? "no previous session in this directory" : `session ${args.resume} not found (wcode sessions)`));
      return 2;
    }
    resumeFile = target.file;
  }

  const sessionOptions = {
    cwd,
    registry,
    model,
    policy,
    resumeFile,
    mode: args.edit ? ("edit" as const) : args.plan ? ("plan" as const) : undefined,
    initialPrompt: prompt,
    allowedTools: args.allowedTools?.split(",").map((s) => s.trim()).filter((s) => s !== ""),
    disallowedTools: args.disallowedTools?.split(",").map((s) => s.trim()).filter((s) => s !== ""),
    appendSystemPrompt: args.appendSystemPrompt,
  };
  const useTui = process.stdin.isTTY && process.stdout.isTTY && !args.plain;
  if (useTui) await runTuiSession(sessionOptions);
  else await runPlainSession(sessionOptions);
  return 0;
}

async function cmdModels(): Promise<number> {
  const registry = loadRegistry();
  const entries = listModels(registry);
  if (entries.length === 0) {
    console.log(style.dim(`no models configured. Create ${CONFIG_PATH} (see wcode help).`));
    return 0;
  }
  for (const entry of entries) {
    const mark = entry.available ? fg.green("✓") : fg.red("✗");
    const def = entry.key === registry.config.defaultModel ? style.bold(" (default)") : "";
    console.log(`${mark} ${style.bold(entry.key)}${def}  ${style.dim(entry.provider.api)}`);
  }
  return 0;
}

async function cmdKey(rest: string[]): Promise<number> {
  const [provider, key] = rest;
  if (!provider || !key) {
    console.error("usage: wcode key <provider> <api-key>");
    return 2;
  }
  const path = saveProviderApiKey(provider, key);
  console.log(fg.green(`saved API key for "${provider}" to ${path}`));
  return 0;
}

async function cmdSessions(): Promise<number> {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log(style.dim("no saved sessions yet"));
    return 0;
  }
  const cwd = process.cwd();
  sessions.slice(0, 20).forEach((s, i) => {
    const here = s.cwd === cwd ? style.bold(" *") : "";
    console.log(
      `${style.bold(String(i + 1).padStart(2))}  ${style.dim(s.createdAt.slice(0, 16).replace("T", " "))}  ${style.dim(s.model)}  ${s.title ?? (s.preview || style.dim("(empty)"))}${here}`,
    );
  });
  return 0;
}

// ---------------------------------------------------------------------------

interface PrintRunOptions {
  prompt: string;
  cwd: string;
  model: ReturnType<typeof resolveModel>;
  policy: PermissionPolicy;
  registry: ReturnType<typeof loadRegistry>;
  allowedTools?: string[];
  disallowedTools?: string[];
  outputFormat: "text" | "json";
  appendSystemPrompt?: string;
}

async function runPrint(options: PrintRunOptions): Promise<number> {
  const { prompt, cwd, model, policy, registry } = options;
  const settings = loadSettings(cwd);
  const gate = new PermissionGate(
    [...settings.settings.allow, ...(options.allowedTools ?? [])],
    [...settings.settings.deny, ...(options.disallowedTools ?? [])],
  );

  // Custom commands expand to their template in print mode too.
  const effectivePrompt = prompt.startsWith("/")
    ? (() => {
        const match = prompt.match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i);
        if (!match) return prompt;
        const custom = findCustomCommand(cwd, match[1]!);
        return custom ? expandCommand(custom, match[2] ?? "") : prompt;
      })()
    : prompt;

  const tools = createTools({ supportsImages: (model.model.input ?? ["text"]).includes("image"), policy });
  const projectInstructions = await loadProjectInstructions(cwd);
  const requestPermission = async (req: { tool: string; summary: string }): Promise<boolean> => {
    console.error(fg.yellow(`[permission denied in print mode: ${req.tool}: ${req.summary} — rerun with --yolo to allow]`));
    return false;
  };

  // MCP servers from config / .mcp.json join the print run too (best effort).
  const mcp = new McpRegistry(loadMcpServers(cwd, registry));
  await mcp.start();
  tools.push(...mcp.tools());

  // Subagent dispatch works in print mode as well; mutations still deny
  // (non-yolo print runs refuse all writes) or flow through --yolo.
  tools.push(
    createTaskTool({
      cwd,
      model: () => model,
      effectivePolicy: () => policy,
      requestPermission,
      gate: () => (gate.isEmpty ? undefined : gate),
      baseTools: () => tools.filter((t) => t.name !== "task"),
    }),
  );

  const agent = new Agent({
    cwd,
    model,
    system: buildSystemPrompt({ cwd, toolNames: tools.map((t) => t.name), projectInstructions, append: options.appendSystemPrompt }),
    tools,
    policy,
    gate: gate.isEmpty ? undefined : gate,
    requestPermission,
  });

  const isTty = process.stdout.isTTY;
  const isJson = options.outputFormat === "json";
  let resultText = "";
  let sawError = false;
  let lastWasText = false;
  const newlineIfNeeded = () => {
    if (lastWasText) {
      process.stdout.write("\n");
      lastWasText = false;
    }
  };
  const handleEvent = (event: AgentEvent) => {
    switch (event.type) {
      case "text_delta":
        if (isJson) resultText += event.delta;
        else {
          process.stdout.write(event.delta);
          lastWasText = true;
        }
        break;
      case "thinking_delta":
        if (!isJson) process.stderr.write(style.dim(event.delta));
        break;
      case "tool_start":
        newlineIfNeeded();
        if (isTty && !isJson) console.error(fg.cyan(`● ${event.call.name} ${event.summary}`));
        break;
      case "tool_update":
        // Subagent/task progress streams here too — parallel tasks used to
        // be silent between dispatch and report in print mode.
        if (isTty && !isJson) {
          newlineIfNeeded();
          console.error(style.dim(`  ↳ ${event.line}`));
        }
        break;
      case "tool_end":
        if (isTty && !isJson) console.error(`  ${event.isError ? fg.red("✗") : fg.green("✓")} ${event.call.name} ${style.dim(formatDuration(event.durationMs))}`);
        break;
      case "notice":
        if (!isJson) {
          newlineIfNeeded();
          console.error(style.dim(event.message));
        }
        break;
      case "error":
        sawError = true;
        if (isJson) resultText += `\n[error] ${event.errorMessage}`;
        else {
          newlineIfNeeded();
          console.error(fg.red(`error: ${event.errorMessage}`));
        }
        break;
      default:
        break;
    }
  };

  let exitCode = 0;
  process.on("SIGINT", () => agent.abort());
  const totals = await agent.run(effectivePrompt, handleEvent);
  if (isJson) {
    console.log(
      JSON.stringify(
        {
          result: resultText.trim(),
          model: model.key,
          is_error: sawError,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cost: Number(totals.cost.toFixed(6)),
        },
        null,
        2,
      ),
    );
  } else {
    newlineIfNeeded();
    if (isTty && (totals.inputTokens > 0 || totals.outputTokens > 0)) {
      console.error(style.dim(`\n[in ${totals.inputTokens} tok, out ${totals.outputTokens} tok]`));
    }
  }
  if (sawError) exitCode = 1;
  mcp.close();
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(fg.red(`fatal: ${(err as Error)?.stack ?? err}`));
    process.exit(1);
  });
