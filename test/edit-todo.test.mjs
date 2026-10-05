// Edit mode + task list (todo_write) tests: permission semantics per mutation
// type, three-state mode cycle, todo tool validation/rendering, session
// persistence, and end-to-end REPL runs against the mock provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import mockOpenai from "./mock-openai.mjs";
import { createTools, runTool } from "../dist/tools/index.js";
import { createTodoWriteTool, renderTodos, todoProgress, parseTodoItems } from "../dist/tools/todo.js";
import { SessionController } from "../dist/ui/session.js";
import { SessionStore, loadSessionMessages } from "../dist/session/store.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "wcode.js");

const okCtx = (dir) => ({ cwd: dir, readFileState: new Map(), requestPermission: async () => true });

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

test("edit policy: file tools auto-approved (no ask), bash still asks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcode-edit-ut-"));
  const tools = createTools({ supportsImages: false, policy: "ask" });
  const asked = [];
  const ctx = okCtx(dir);
  ctx.requestPermission = async (req) => {
    asked.push(req.tool);
    return false; // deny everything that reaches the prompt
  };

  // write/edit are mutation:"file" → auto-approved in edit mode, never asked
  const file = join(dir, "new.txt");
  const w = await runTool(tools, "write", { path: file, content: "created\n" }, ctx, "edit");
  assert.equal(w.isError, false, `write should succeed in edit mode: ${w.output.content[0].text}`);
  assert.equal(readFileSync(file, "utf8"), "created\n");
  assert.ok(!asked.includes("write"), "edit mode must not prompt for file edits");

  // bash is mutation:"shell" → still asks; denial blocks execution
  const b = await runTool(tools, "bash", { command: "echo ran > bash-out.txt" }, ctx, "edit");
  assert.equal(b.isError, true, "denied bash must fail in edit mode");
  assert.ok(asked.includes("bash"), "edit mode must still prompt for bash");
  assert.ok(!existsSync(join(dir, "bash-out.txt")));

  // allowing the prompt lets bash run
  ctx.requestPermission = async () => true;
  const b2 = await runTool(tools, "bash", { command: "echo ran > bash-out.txt" }, ctx, "edit");
  assert.equal(b2.isError, false);
});

test("edit policy: precedence — plan still blocks, yolo still allows everything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcode-edit-prec-"));
  const tools = createTools({ supportsImages: false, policy: "ask" });
  const plan = await runTool(tools, "write", { path: join(dir, "x.txt"), content: "x" }, okCtx(dir), "plan");
  assert.equal(plan.isError, true, "plan mode must keep blocking file tools");
  const yolo = await runTool(tools, "bash", { command: "echo ok" }, okCtx(dir), "yolo");
  assert.equal(yolo.isError, false, "yolo keeps allowing bash");
});

// ---------------------------------------------------------------------------
// Task list (todo_write)
// ---------------------------------------------------------------------------

test("todo_write: validates shape, reports progress, renders checklist", async () => {
  const seen = [];
  const tool = createTodoWriteTool((todos) => seen.push(todos));
  assert.equal(tool.name, "todo_write");
  assert.equal(tool.readOnly, true, "task list updates need no permission");

  const out = await tool.execute(
    {
      todos: [
        { content: "first", status: "completed" },
        { content: "second", status: "in_progress" },
        { content: "third", status: "pending" },
      ],
    },
    okCtx("/tmp"),
  );
  assert.equal(seen.length, 1);
  assert.equal(todoProgress(seen[0]), "1/3");
  assert.match(out.content[0].text, /Todo list updated: 1\/3/);
  assert.equal(out.display, "todos 1/3");
  assert.equal(renderTodos(seen[0]), "☑ first\n◐ second\n☐ third");

  // invalid shapes fail with the offending index
  assert.throws(() => parseTodoItems("nope"), /must be an array/);
  assert.throws(() => parseTodoItems([]), /must not be empty/);
  assert.throws(() => parseTodoItems([{ content: "", status: "pending" }]), /todos\[0\]\.content/);
  assert.throws(() => parseTodoItems([{ content: "x", status: "done" }]), /todos\[0\]\.status/);
  await assert.rejects(() => tool.execute({ todos: [{ content: "x", status: "pending" }, "junk"] }, okCtx("/tmp")), /todos\[1\]/);
});

test("todo_write: persisted into the session store and restored on load", async () => {
  const home = mkdtempSync(join(tmpdir(), "wcode-todo-store-"));
  const orig = process.env.WCODE_DIR;
  process.env.WCODE_DIR = home;
  try {
    const store = new SessionStore("/proj", "test/m1");
    const todos = [
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
    ];
    store.recordTodos(todos);
    store.recordTodos([{ content: "c", status: "in_progress" }]); // last one wins
    const loaded = loadSessionMessages(store.filePath);
    assert.deepEqual(loaded.todos, [{ content: "c", status: "in_progress" }]);
  } finally {
    if (orig === undefined) delete process.env.WCODE_DIR;
    else process.env.WCODE_DIR = orig;
  }
});

// ---------------------------------------------------------------------------
// Controller: mode cycle, precedence, todos state
// ---------------------------------------------------------------------------

function makeController(cwd, hooks, mode, policy = "ask") {
  const provider = { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: [{ id: "test-model" }] };
  return new SessionController(
    {
      cwd,
      registry: { config: { providers: { mockai: provider } }, configPath: "/dev/null", providers: { mockai: provider } },
      model: { key: "mockai/test-model", providerId: "mockai", provider, model: { id: "test-model" }, headers: {} },
      policy,
      mode,
    },
    hooks,
  );
}

const silentHooks = {
  print: () => {},
  onEvent: () => {},
  askPermission: async () => true,
  askPlanApproval: async () => true,
};

test("controller: shift+tab cycle build → edit → plan → build with correct gates", () => {
  const home = mkdtempSync(join(tmpdir(), "wcode-cycle-"));
  process.env.WCODE_DIR = home;
  try {
    const controller = makeController(home, silentHooks);
    assert.equal(controller.mode, "build");
    assert.equal(controller.agent.options.policy, "ask");

    assert.equal(controller.toggleMode(), "edit");
    assert.equal(controller.agent.options.policy, "edit");

    assert.equal(controller.toggleMode(), "plan");
    assert.equal(controller.agent.options.policy, "plan");

    assert.equal(controller.toggleMode(), "build");
    assert.equal(controller.agent.options.policy, "ask");
  } finally {
    if (process.env.WCODE_DIR === home) delete process.env.WCODE_DIR;
  }
});

test("controller: yolo overrides edit mode but never plan mode", () => {
  const home = mkdtempSync(join(tmpdir(), "wcode-prec-"));
  process.env.WCODE_DIR = home;
  try {
    const controller = makeController(home, silentHooks, "edit", "yolo");
    assert.equal(controller.agent.options.policy, "yolo", "yolo beats edit");
    controller.setMode("plan");
    assert.equal(controller.agent.options.policy, "plan", "plan beats yolo");
    controller.setMode("build");
    assert.equal(controller.agent.options.policy, "yolo");
  } finally {
    if (process.env.WCODE_DIR === home) delete process.env.WCODE_DIR;
  }
});

test("controller: todo_write updates state and /todos prints it", async () => {
  const home = mkdtempSync(join(tmpdir(), "wcode-todo-ctl-"));
  process.env.WCODE_DIR = home;
  const printed = [];
  try {
    const controller = makeController(home, { ...silentHooks, print: (l) => printed.push(l) });
    const todoTool = controller.agent.options.tools.find((t) => t.name === "todo_write");
    assert.ok(todoTool, "todo_write must be in the build toolset");
    await todoTool.execute({ todos: [{ content: "ship it", status: "in_progress" }] }, okCtx(home));
    assert.equal(controller.todos.length, 1);
    assert.equal(controller.todos[0].content, "ship it");

    await controller.handleLine("/todos");
    assert.ok(printed.some((l) => l.includes("◐ ship it")), `printed: ${printed}`);

    // clearConversation clears the list too (fresh task, fresh list)
    controller.clearConversation();
    assert.equal(controller.todos.length, 0);
  } finally {
    if (process.env.WCODE_DIR === home) delete process.env.WCODE_DIR;
  }
});

// ---------------------------------------------------------------------------
// E2E: real CLI + mock provider
// ---------------------------------------------------------------------------

function startServer(t) {
  const httpServer = mockOpenai.server;
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve(httpServer));
  }).then((httpServer) => {
    t.after(() => {
      httpServer.close();
      httpServer.closeAllConnections?.();
    });
    return httpServer;
  });
}

function repl(args, inputs, env) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: env.project,
    env: { ...process.env, WCODE_DIR: env.home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 20000);
  child.stdin.end(inputs);
  return {
    done: new Promise((resolve) =>
      child.on("close", (code) => {
        clearTimeout(watchdog);
        resolve({ code, out, err });
      }),
    ),
  };
}

test("e2e: edit mode — write runs without the permission prompt, exit on /exit", async (t) => {
  const httpServer = await startServer(t);
  const port = httpServer.address().port;
  const home = mkdtempSync(join(tmpdir(), "wcode-edit-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-edit-proj-"));
  writeFileSync(join(project, "WCODE.md"), "WRITE-TASK: create agent-output.txt\n");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      providers: {
        mockai: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "mock-key-123", models: [{ id: "test-model" }] },
      },
    }),
  );
  const base = mockOpenai.state.requests.length;
  // NOTE: no "y" line — edit mode must not need one for the write.
  const { done } = repl(["--edit"], "create the file\n/exit\n", { home, project });
  const { code, out, err } = await done;
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /WRITE_DONE/);
  assert.equal(readFileSync(join(project, "agent-output.txt"), "utf8"), "written by wcode agent\n");
  assert.ok(!/[?⏸] (write|bash):/.test(out), `no permission prompt expected, got: ${out}`);
  // system prompt carries the todo guidance in every mode
  assert.match(mockOpenai.state.requests[base].messages[0].content, /todo_write/);
});

test("e2e: todo_write round-trips through the agent loop", async (t) => {
  const httpServer = await startServer(t);
  const port = httpServer.address().port;
  const home = mkdtempSync(join(tmpdir(), "wcode-todo-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-todo-proj-"));
  writeFileSync(join(project, "WCODE.md"), "TODO-TASK: track the multi-step work\n");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      providers: {
        mockai: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "mock-key-123", models: [{ id: "test-model" }] },
      },
    }),
  );
  const base = mockOpenai.state.requests.length;
  const { done } = repl([], "track the work\n/exit\n", { home, project });
  const { code, out, err } = await done;
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /TODO_OK:list-tracked/);

  // request 1 offered todo_write; request 2 carried the tool result back
  const names1 = mockOpenai.state.requests[base].tools.map((tool) => tool.function?.name ?? tool.name);
  assert.ok(names1.includes("todo_write"));
  const req2 = mockOpenai.state.requests[base + 1];
  const toolMsg = req2.messages.find((m) => m.role === "tool");
  assert.match(String(toolMsg?.content), /Todo list updated: 1\/3 completed/);
});
