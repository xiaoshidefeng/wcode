// Tool registry for the coding agent.

import type { PermissionGate } from "../permissions.js";
import { permissionSubject } from "../permissions.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import type { Tool, ToolContext, ToolOutput, ToolPermissionRequest } from "./types.js";
import { ToolError } from "./types.js";
import { createWriteTool } from "./write.js";
import { createWebFetchTool, createWebSearchTool } from "./web.js";

/** User's permission preference, chosen at startup or via /yolo. */
export type PermissionPolicy = "ask" | "yolo";
/** Runtime gate: "edit" auto-approves file edits, "plan" hard-blocks mutations. */
export type ToolPolicy = PermissionPolicy | "plan" | "edit";

export interface CreateToolsOptions {
  supportsImages: boolean;
  policy: PermissionPolicy;
}

export function createTools(options: CreateToolsOptions): Tool[] {
  return [
    createReadTool(options.supportsImages),
    createWriteTool(),
    createEditTool(),
    createBashTool(),
    createGrepTool(),
    createGlobTool(),
    createLsTool(),
    createWebFetchTool(),
    createWebSearchTool(),
  ];
}

export interface ToolRunResult {
  output: ToolOutput;
  isError: boolean;
}

/**
 * Execute one tool call with schema-ish validation and permission handling.
 * Errors become error tool results — they never throw into the agent loop.
 *
 * `gate` carries allow/deny rules from settings.json / CLI flags: a deny rule
 * hard-blocks the call in every mode, an allow rule skips the y/N ask.
 */
export async function runTool(
  tools: Tool[],
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  policy: ToolPolicy,
  gate?: PermissionGate,
): Promise<ToolRunResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return {
      output: { content: [{ type: "text", text: `unknown tool "${name}"` }], display: `unknown tool ${name}` },
      isError: true,
    };
  }
  // The identifying subject rides on every permission request so the UI can
  // offer "always allow" (a rule is derived from it in the controller).
  const subject = permissionSubject(name, args, ctx.cwd);
  const askCtx: ToolContext = { ...ctx, requestPermission: (req) => ctx.requestPermission({ ...req, subject }) };
  if (gate) {
    const decision = gate.decide(name, subject);
    if (decision === "deny") {
      const rule = gate.matchedDeny(name, subject) ?? "deny rule";
      return {
        output: {
          content: [
            {
              type: "text",
              text: `Error: "${name}" was denied by a permission rule (${rule}) in the user's settings. Do not retry this call; choose a different approach.`,
            },
          ],
          display: `${name} denied (${rule})`,
        },
        isError: true,
      };
    }
  }
  // Plan mode is read-only: mutating calls are blocked before execution with a
  // reason (pi-style block), so the model can adapt instead of retrying.
  if (policy === "plan" && !tool.readOnly) {
    return {
      output: {
        content: [
          {
            type: "text",
            text: `Error: "${name}" is blocked in plan mode (read-only research). Use read/grep/glob/ls to investigate, then call exit_plan with your finished plan. The user must approve it before anything can be modified.`,
          },
        ],
        display: `${name} blocked (plan mode)`,
      },
      isError: true,
    };
  }
  const preApproved = gate?.decide(name, subject) === "allow";
  // Built-in guard: secret files ask before every read, in every mode — the
  // read tool never asks on its own, so runTool owns this check.
  let envApproved = false;
  if (isSecretFile(name, subject)) {
    envApproved = await askCtx.requestPermission({ tool: name, summary: `read ${subject}` });
    if (!envApproved) {
      return {
        output: {
          content: [
            {
              type: "text",
              text: `Error: reading "${subject}" was denied. It looks like a secrets file (.env) — ask the user how to proceed instead of retrying.`,
            },
          ],
          display: `read ${subject} denied (secret file)`,
        },
        isError: true,
      };
    }
  }
  try {
    const output = await tool.execute(args, withPermission(tool, askCtx, policy, preApproved || envApproved));
    return { output, isError: false };
  } catch (err) {
    if (err instanceof ToolError) {
      return { output: { content: [{ type: "text", text: `Error: ${err.message}` }], display: `${name} failed: ${err.message}` }, isError: true };
    }
    return {
      output: {
        content: [{ type: "text", text: `Error executing ${name}: ${(err as Error)?.message ?? String(err)}` }],
        display: `${name} failed: ${(err as Error)?.message ?? String(err)}`,
      },
      isError: true,
    };
  }
}

/**
 * Built-in secret-file guard (opencode's default permission rules): reading
 * `.env`-style files asks even in yolo/edit modes — a leaked dotenv is the
 * classic hands-off-run accident. An explicit allow rule in settings still
 * wins (the gate decides before this), and `.env.example` files are exempt.
 */
function isSecretFile(tool: string, subject: string | undefined): boolean {
  if (tool !== "read" || !subject) return false;
  const base = subject.split(/[\\/]/).pop()!.toLowerCase();
  if (base === ".env" || base.startsWith(".env.") || base.endsWith(".env")) {
    return !base.endsWith(".env.example");
  }
  return false;
}

function withPermission(tool: Tool, ctx: ToolContext, policy: ToolPolicy, preApproved = false): ToolContext {
  if (policy === "yolo" || tool.readOnly || preApproved) {
    return { ...ctx, requestPermission: async () => true };
  }
  // Edit mode auto-accepts file edits; shell commands still ask (the whole
  // point of the mode: fewer prompts on code changes, commands stay gated).
  if (policy === "edit" && tool.mutation === "file") {
    return { ...ctx, requestPermission: async () => true };
  }
  return ctx;
}

/**
 * Toolset offered to the model in plan mode: read-only explorers plus
 * exit_plan (pi's Layer A — capability removal, so the model never even sees
 * write/edit/bash schemas). runTool's "plan" policy is the enforcement
 * backstop for mid-turn mode switches.
 */
export function planModeTools(tools: Tool[], exitPlan: Tool): Tool[] {
  return [...tools.filter((t) => t.readOnly), exitPlan];
}

export type { Tool, ToolContext, ToolPermissionRequest };
