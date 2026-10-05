import type { ToolResultContent } from "../types.js";

/** What a tool hands back: content goes to the model, display goes to the UI. */
export interface ToolOutput {
  content: ToolResultContent[];
  /** Short line for the transcript UI (e.g. "Read 120 lines"). */
  display: string;
  /** Optional multi-line detail block shown under the display line. */
  detail?: string;
  /** File mutation summary (write/edit), aggregated into the turn summary. */
  change?: { path: string; added: number; removed: number };
}

export interface ToolPermissionRequest {
  tool: string;
  summary: string;
  detail?: string;
}

export interface ToolContext {
  cwd: string;
  /** Files the agent has Read this session (path -> content hash at read time). */
  readFileState: Map<string, { hash: string; mtimeMs: number }>;
  /** Ask the user before a mutating action. Resolved by the UI layer. */
  requestPermission: (req: ToolPermissionRequest) => Promise<boolean>;
  signal?: AbortSignal;
  /** Streaming progress from long-running tools (bash output). */
  onUpdate?: (line: string) => void;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the parameters object. */
  parameters: Record<string, unknown>;
  /** Read-only tools run in parallel and never need permission. */
  readOnly: boolean;
  /** For mutating tools: "file" edits files (auto-approved in edit mode), "shell" runs commands (always asks). */
  mutation?: "file" | "shell";
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export class ToolError extends Error {}

export function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (typeof v === "string") return v;
  if (v === undefined && fallback !== undefined) return fallback;
  throw new ToolError(`missing required string argument "${key}"`);
}
export function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) return Number(v);
  throw new ToolError(`argument "${key}" must be a number`);
}
export function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  if (v === undefined) return fallback;
  return Boolean(v);
}
