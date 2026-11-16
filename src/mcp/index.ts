// MCP registry: load server configs (user config.json + project .mcp.json),
// connect, and expose each server tool to the model as `mcp__<server>__<tool>`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderRegistry } from "../config.js";
import type { Tool, ToolContext, ToolOutput } from "../tools/types.js";
import { ToolError } from "../tools/types.js";
import { stripJsonComments } from "../jsonc.js";
import { McpClient, type McpServerConfig, type McpToolResponse } from "./client.js";

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  source: "user" | "project";
}

interface RawMcpConfig {
  mcpServers?: Record<string, { command?: unknown; args?: unknown; env?: unknown; timeout?: unknown }>;
}

function parseServers(raw: unknown, source: "user" | "project"): McpServerEntry[] {
  const out: McpServerEntry[] = [];
  const cfg = raw as RawMcpConfig | undefined;
  if (!cfg?.mcpServers || typeof cfg.mcpServers !== "object") return out;
  for (const [name, entry] of Object.entries(cfg.mcpServers)) {
    if (!entry || typeof entry !== "object" || typeof entry.command !== "string") continue;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue; // tool names must stay sane
    out.push({
      name,
      source,
      config: {
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : undefined,
        env: entry.env && typeof entry.env === "object" ? sanitizeEnv(entry.env) : undefined,
        timeout: typeof entry.timeout === "number" ? entry.timeout : undefined,
      },
    });
  }
  return out;
}

function sanitizeEnv(env: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Merge mcpServers: user config.json first, project .mcp.json wins by name. */
export function loadMcpServers(cwd: string, registry: ProviderRegistry): McpServerEntry[] {
  const user = parseServers(registry.config, "user");
  let project: McpServerEntry[] = [];
  const mcpJson = join(cwd, ".mcp.json");
  if (existsSync(mcpJson)) {
    try {
      project = parseServers(JSON.parse(stripJsonComments(readFileSync(mcpJson, "utf8"))), "project");
    } catch {
      /* broken .mcp.json — skip */
    }
  }
  const byName = new Map<string, McpServerEntry>();
  for (const e of user) byName.set(e.name, e);
  for (const e of project) byName.set(e.name, e);
  return [...byName.values()];
}

export interface McpServerStatus {
  name: string;
  source: "user" | "project";
  connected: boolean;
  toolCount: number;
  error?: string;
}

/** Connects every configured server and adapts their tools for the agent. */
export class McpRegistry {
  private readonly clients = new Map<string, McpClient>();
  private readonly toolsByServer = new Map<string, Tool[]>();
  private statuses: McpServerStatus[] = [];
  private started = false;

  constructor(private readonly entries: McpServerEntry[]) {}

  /** Connect to all servers (best effort — a failing server never blocks the session). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await Promise.all(
      this.entries.map(async (entry) => {
        try {
          const client = await McpClient.connect(entry.name, entry.config);
          const defs = await client.listTools();
          this.clients.set(entry.name, client);
          this.toolsByServer.set(
            entry.name,
            defs.map((def) => adaptTool(entry.name, client, def)),
          );
          this.statuses.push({ name: entry.name, source: entry.source, connected: true, toolCount: defs.length });
        } catch (err) {
          this.statuses.push({
            name: entry.name,
            source: entry.source,
            connected: false,
            toolCount: 0,
            error: (err as Error).message,
          });
        }
      }),
    );
  }

  get ready(): boolean {
    return this.started;
  }

  /** All tools from all connected servers, flattened. */
  tools(): Tool[] {
    return [...this.toolsByServer.values()].flat();
  }

  status(): McpServerStatus[] {
    return this.statuses;
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
  }
}

/** Wrap one MCP tool definition as a wcode Tool (name: mcp__server__tool). */
function adaptTool(server: string, client: McpClient, def: { name: string; description?: string; inputSchema?: Record<string, unknown> }): Tool {
  const qualified = `mcp__${server}__${def.name}`;
  const parameters =
    def.inputSchema && typeof def.inputSchema === "object" && (def.inputSchema as { type?: string }).type === "object"
      ? def.inputSchema
      : { type: "object", properties: {} };
  return {
    name: qualified,
    description: def.description ? `[MCP: ${server}] ${def.description}` : `[MCP: ${server}] tool "${def.name}"`,
    readOnly: false, // semantics unknown — the permission prompt decides
    parameters,
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolOutput> {
      const response = await client.callTool(def.name, args);
      return mcpResponseToOutput(server, def.name, response);
    },
  };
}

export function mcpResponseToOutput(server: string, tool: string, response: McpToolResponse): ToolOutput {
  const content: ToolOutput["content"] = [];
  const displayParts: string[] = [];
  for (const raw of response.content ?? []) {
    const item = raw as { type?: string; text?: unknown; data?: unknown; mimeType?: unknown; resource?: { text?: unknown } };
    if (item.type === "text" && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
      displayParts.push(item.text);
    } else if (item.type === "image" && typeof item.data === "string") {
      content.push({ type: "image", media: { type: "base64", mediaType: typeof item.mimeType === "string" ? item.mimeType : "image/png", data: item.data } });
      displayParts.push("[image]");
    } else if (item.type === "resource" && typeof item.resource?.text === "string") {
      content.push({ type: "text", text: item.resource.text });
      displayParts.push(item.resource.text);
    }
  }
  const flat = displayParts.join("\n").trim();
  if (response.isError) {
    throw new ToolError(flat === "" ? `MCP tool ${server}/${tool} failed` : `MCP tool error: ${flat}`);
  }
  return {
    content: content.length > 0 ? content : [{ type: "text", text: "(empty response)" }],
    display: `mcp:${server} ${tool}`,
    detail: flat === "" ? undefined : flat.split("\n").slice(0, 6).join("\n"),
  };
}
