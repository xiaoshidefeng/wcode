// Minimal MCP (Model Context Protocol) client over stdio: newline-delimited
// JSON-RPC 2.0 with the server process. Supports the surface wcode needs —
// initialize, tools/list, tools/call — and nothing more.

import { spawn, type ChildProcess } from "node:child_process";

/** One server entry from mcpServers config (config.json or .mcp.json). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per-call timeout in ms (default 30_000). */
  timeout?: number;
}

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private stderrTail: string[] = [];
  private closed = false;

  private constructor(
    readonly serverName: string,
    private readonly config: McpServerConfig,
  ) {}

  /** Spawn the server process and complete the MCP initialize handshake. */
  static async connect(serverName: string, config: McpServerConfig): Promise<McpClient> {
    const client = new McpClient(serverName, config);
    await client.start();
    return client;
  }

  private async start(): Promise<void> {
    const child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
    });
    this.child = child;
    child.on("error", (err) => this.failAll(new Error(`MCP server "${this.serverName}" failed to start: ${err.message}`)));
    child.on("exit", (code) => {
      if (!this.closed) this.failAll(new Error(`MCP server "${this.serverName}" exited (code ${code})${this.stderrHint()}`));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString());
      if (this.stderrTail.length > 30) this.stderrTail.shift();
    });
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));

    const result = (await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "wcode", version: "0.2.0" },
    })) as { serverInfo?: { name?: string } };
    this.notify("notifications/initialized", {});
    void result;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line === "") continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not JSON-RPC — ignore
      }
      if (typeof msg.id !== "number") continue; // notification from server
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP request failed"));
      else pending.resolve(msg.result);
    }
  }

  private stderrHint(): string {
    const tail = this.stderrTail.join("").trim();
    return tail === "" ? "" : `: ${tail.slice(-300)}`;
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private send(method: string, params: unknown): number {
    const id = this.nextId++;
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return id;
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.child || this.child.exitCode !== null) {
      return Promise.reject(new Error(`MCP server "${this.serverName}" is not running`));
    }
    const id = this.send(method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.serverName}" timed out on ${method} (${this.timeoutMs()}ms)`));
      }, this.timeoutMs());
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private timeoutMs(): number {
    return this.config.timeout ?? DEFAULT_TIMEOUT;
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDef[] };
    return Array.isArray(result.tools) ? result.tools : [];
  }

  /**
   * Respawn the server process and redo the handshake after it died
   * (opencode-style transparent reconnect — tool definitions stay valid).
   */
  async restart(): Promise<void> {
    if (this.alive) return;
    this.failAll(new Error(`MCP server "${this.serverName}" is restarting`));
    this.buffer = "";
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
    await this.start();
  }

  /** Raw tools/call result: content items as the server returned them. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResponse> {
    if (!this.alive && !this.closed) {
      // One transparent restart per call; a server that won't come back
      // surfaces its real error instead of hanging the tool result.
      await this.restart();
    }
    const result = (await this.request("tools/call", { name, arguments: args })) as McpToolResponse;
    return result ?? { content: [] };
  }

  get alive(): boolean {
    return !this.closed && this.child !== null && this.child.exitCode === null;
  }

  /** Last stderr lines, shown by /status when a server misbehaves. */
  get diagnostics(): string {
    return this.stderrTail.join("").trim();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(`MCP server "${this.serverName}" was closed`));
    try {
      this.child?.stdin?.end();
      this.child?.kill();
    } catch {
      /* already gone */
    }
  }
}

/** tools/call result shape (subset of the MCP spec wcode consumes). */
export interface McpToolResponse {
  content?: McpContentItem[];
  isError?: boolean;
}

export type McpContentItem =
  | { type: "text"; text?: string }
  | { type: "image"; data?: string; mimeType?: string }
  | { type: "audio"; data?: string; mimeType?: string }
  | { type: "resource"; resource?: { text?: string; uri?: string; mimeType?: string } }
  | { type: string };
