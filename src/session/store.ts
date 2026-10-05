// Session persistence: append-only JSONL, one line per message (pi-style).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "../config.js";
import type { Message } from "../types.js";
import type { TodoItem } from "../tools/todo.js";

interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  cwd: string;
  createdAt: string;
  model: string;
}
type SessionLine =
  | SessionHeader
  | { type: "message"; message: Message }
  | { type: "model"; model: string }
  | { type: "todos"; todos: TodoItem[] };

export class SessionStore {
  readonly id: string;
  readonly filePath: string;
  private header: SessionHeader;
  private dirty = 0;

  constructor(cwd: string, modelKey: string, id?: string) {
    this.id = id ?? randomId();
    mkdirSync(SESSIONS_DIR, { recursive: true });
    this.filePath = join(SESSIONS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}_${this.id}.jsonl`);
    this.header = {
      type: "session",
      version: 1,
      id: this.id,
      cwd,
      createdAt: new Date().toISOString(),
      model: modelKey,
    };
    this.flushHeader();
  }

  private flushHeader(): void {
    writeFileSync(this.filePath, JSON.stringify(this.header) + "\n");
  }

  setModel(modelKey: string): void {
    this.header.model = modelKey;
    appendFileSync(this.filePath, JSON.stringify({ type: "model", model: modelKey } satisfies SessionLine) + "\n");
  }

  /** Hook for AgentOptions.onMessagesChanged — appends only new messages. */
  record(messages: Message[]): void {
    for (; this.dirty < messages.length; this.dirty++) {
      appendFileSync(this.filePath, JSON.stringify({ type: "message", message: messages[this.dirty] } satisfies SessionLine) + "\n");
    }
  }

  /** Append the latest task list; loading takes the last todos line. */
  recordTodos(todos: TodoItem[]): void {
    appendFileSync(this.filePath, JSON.stringify({ type: "todos", todos } satisfies SessionLine) + "\n");
  }

  get messageCount(): number {
    return this.dirty;
  }
}

export interface SessionSummary {
  file: string;
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  messageCount: number;
  preview: string;
}

export function listSessions(): SessionSummary[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const summaries: SessionSummary[] = [];
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".jsonl")) continue;
    const full = join(SESSIONS_DIR, file);
    try {
      const parsed = parseSessionFile(full);
      summaries.push(parsed);
    } catch {
      /* skip corrupt files */
    }
  }
  summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return summaries;
}

export function parseSessionFile(file: string): SessionSummary {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  const header = JSON.parse(lines[0]!) as SessionHeader;
  const firstUser = lines.map((l) => JSON.parse(l) as SessionLine).find((l) => l.type === "message" && l.message.role === "user");
  let preview = "";
  if (firstUser && firstUser.type === "message") {
    const block = firstUser.message.content.find((b) => b.type === "text");
    if (block && block.type === "text") preview = block.text.slice(0, 80);
  }
  return {
    file,
    id: header.id,
    cwd: header.cwd,
    model: header.model,
    createdAt: header.createdAt,
    messageCount: lines.length - 1,
    preview,
  };
}

export function loadSessionMessages(file: string): { messages: Message[]; header: SessionHeader; todos?: TodoItem[] } {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  const header = JSON.parse(lines[0]!) as SessionHeader;
  const messages: Message[] = [];
  let model = header.model;
  let todos: TodoItem[] | undefined;
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line) as SessionLine;
    if (entry.type === "message") messages.push(entry.message);
    else if (entry.type === "model") model = entry.model;
    else if (entry.type === "todos") todos = entry.todos;
  }
  header.model = model;
  return { messages, header, todos };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Path of the most recent session recorded in the given cwd (best effort). */
export function latestSessionFor(cwd: string): string | undefined {
  return listSessions().find((s) => s.cwd === cwd)?.file;
}
