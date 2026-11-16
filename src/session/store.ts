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
  | { type: "todos"; todos: TodoItem[] }
  | { type: "title"; title: string };

export class SessionStore {
  readonly id: string;
  readonly filePath: string;
  private header: SessionHeader;
  private dirty = 0;
  private title: string | undefined;

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

  /** Append the session title (generated once after the first exchange). */
  setTitle(title: string): void {
    this.title = title;
    appendFileSync(this.filePath, JSON.stringify({ type: "title", title } satisfies SessionLine) + "\n");
  }

  /**
   * Replace the whole transcript (rewind): rewrite header + current messages.
   * Returns the message count now on disk.
   */
  rewrite(messages: Message[]): number {
    writeFileSync(this.filePath, JSON.stringify(this.header) + "\n", "utf8");
    for (const message of messages) {
      appendFileSync(this.filePath, JSON.stringify({ type: "message", message } satisfies SessionLine) + "\n");
    }
    appendFileSync(this.filePath, JSON.stringify({ type: "model", model: this.header.model } satisfies SessionLine) + "\n");
    // A rewrite (compact/rewind) must not lose the generated title.
    if (this.title !== undefined) {
      appendFileSync(this.filePath, JSON.stringify({ type: "title", title: this.title } satisfies SessionLine) + "\n");
    }
    this.dirty = messages.length;
    return messages.length;
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
  title?: string;
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
  let preview = "";
  let title: string | undefined;
  let model = header.model;
  // Single pass over the transcript (listSessions runs on every session file).
  for (let i = 1; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]!) as SessionLine;
    if (entry.type === "title") title = entry.title;
    else if (entry.type === "model") model = entry.model;
    else if (entry.type === "message" && preview === "" && entry.message.role === "user") {
      const block = entry.message.content.find((b) => b.type === "text");
      if (block && block.type === "text") preview = block.text.slice(0, 80);
    }
  }
  return {
    file,
    id: header.id,
    cwd: header.cwd,
    model,
    createdAt: header.createdAt,
    messageCount: lines.length - 1,
    preview,
    ...(title !== undefined ? { title } : {}),
  };
}

export function loadSessionMessages(file: string): { messages: Message[]; header: SessionHeader; todos?: TodoItem[]; title?: string } {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  const header = JSON.parse(lines[0]!) as SessionHeader;
  const messages: Message[] = [];
  let model = header.model;
  let todos: TodoItem[] | undefined;
  let title: string | undefined;
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line) as SessionLine;
    if (entry.type === "message") messages.push(entry.message);
    else if (entry.type === "model") model = entry.model;
    else if (entry.type === "todos") todos = entry.todos;
    else if (entry.type === "title") title = entry.title;
  }
  header.model = model;
  return { messages, header, todos, title };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

