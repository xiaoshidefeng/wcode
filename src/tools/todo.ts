// todo_write: the model's task list (claude-code TodoWrite style). The model
// rewrites the whole list whenever it changes; the controller stores it for
// the status bar and /todos, and the session store persists it for /resume.

import type { Tool, ToolOutput } from "./types.js";
import { ToolError } from "./types.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const GLYPH: Record<TodoStatus, string> = { pending: "☐", in_progress: "◐", completed: "☑" };

/** Checklist rendering shared by the tool card and the /todos command. */
export function renderTodos(todos: TodoItem[]): string {
  return todos.map((t) => `${GLYPH[t.status]} ${t.content}`).join("\n");
}

export function todoProgress(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === "completed").length;
  return `${done}/${todos.length}`;
}

export function parseTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) throw new ToolError("todos must be an array of {content, status}");
  if (raw.length === 0) throw new ToolError("todos must not be empty (skip the call instead of clearing)");
  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null) throw new ToolError(`todos[${i}] must be an object`);
    const { content, status } = item as Record<string, unknown>;
    if (typeof content !== "string" || content.trim() === "") {
      throw new ToolError(`todos[${i}].content must be a non-empty string`);
    }
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new ToolError(`todos[${i}].status must be "pending", "in_progress" or "completed"`);
    }
    return { content, status };
  });
}

export function createTodoWriteTool(onChange: (todos: TodoItem[]) => void): Tool {
  return {
    name: "todo_write",
    description: `Write your task list for the current work. The list replaces the previous one entirely — always send every task, not a delta.

Rules:
- Use it for multi-step tasks (roughly 3+ steps or anything spanning several files). Skip it for trivial work.
- Keep exactly one task "in_progress" at a time; the rest are "pending" or "completed".
- Call again as soon as a task is finished or the plan changes — not batched at the end.
- Task content: short, imperative, specific ("Fix flaky auth retry in session.ts").`,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete task list (replaces the previous one)",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Short imperative task description" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Task state" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const todos = parseTodoItems(args.todos);
      onChange(todos);
      return {
        content: [{ type: "text", text: `Todo list updated: ${todoProgress(todos)} completed.` }],
        display: `todos ${todoProgress(todos)}`,
        detail: renderTodos(todos),
      };
    },
  };
}
