// Tool registry for the coding agent.

import type { ToolSchema } from "../types.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import type { Tool, ToolContext, ToolOutput, ToolPermissionRequest } from "./types.js";
import { ToolError } from "./types.js";
import { createWriteTool } from "./write.js";

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
  ];
}

export function toSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export interface ToolRunResult {
  output: ToolOutput;
  isError: boolean;
}

/**
 * Execute one tool call with schema-ish validation and permission handling.
 * Errors become error tool results — they never throw into the agent loop.
 */
export async function runTool(
  tools: Tool[],
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  policy: ToolPolicy,
): Promise<ToolRunResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return {
      output: { content: [{ type: "text", text: `unknown tool "${name}"` }], display: `unknown tool ${name}` },
      isError: true,
    };
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
  try {
    const output = await tool.execute(args, withPermission(tool, ctx, policy));
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

function withPermission(tool: Tool, ctx: ToolContext, policy: ToolPolicy): ToolContext {
  if (policy === "yolo" || tool.readOnly) {
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
