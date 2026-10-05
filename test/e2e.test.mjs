// End-to-end + unit tests for wcode. Runs the real CLI against two mock
// providers (OpenAI- and Anthropic-compatible) and checks unit-level pieces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import mockOpenai from "./mock-openai.mjs";
import mockAnthropic from "./mock-anthropic.mjs";
import mockResponses from "./mock-responses.mjs";
import { globToRegex } from "../dist/tools/util.js";
import { resolveValue } from "../dist/config.js";
import { stripLineNumbers, addLineNumbers, truncateOutput } from "../dist/tools/util.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "wcode.js");

function run(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("globToRegex handles **, *, ?, braces, char classes", () => {
  assert.ok(globToRegex("src/**/*.ts").test("src/a/b/c.ts"));
  assert.ok(globToRegex("src/**/*.ts").test("src/main.ts"));
  assert.ok(!globToRegex("src/**/*.ts").test("lib/main.ts"));
  assert.ok(globToRegex("*.json").test("package.json"));
  assert.ok(!globToRegex("*.json").test("a/b/package.json"));
  assert.ok(globToRegex("test-?.js").test("test-a.js"));
  assert.ok(!globToRegex("test-?.js").test("test-ab.js"));
  assert.ok(globToRegex("*.{js,ts}").test("x.ts"));
  assert.ok(globToRegex("*.{js,ts}").test("x.js"));
  assert.ok(!globToRegex("*.{js,ts}").test("x.py"));
  assert.ok(globToRegex("src/[abc].ts").test("src/b.ts"));
});

test("resolveValue: env refs, !command, escapes", () => {
  process.env.WCODE_TEST_KEY = "abc123";
  assert.equal(resolveValue("${WCODE_TEST_KEY}"), "abc123");
  assert.equal(resolveValue("$WCODE_TEST_KEY"), "abc123");
  assert.equal(resolveValue("!echo hi-from-cmd"), "hi-from-cmd");
  assert.equal(resolveValue("$${LITERAL}"), "${LITERAL}");
  assert.equal(resolveValue("plain-key"), "plain-key");
  assert.equal(resolveValue("${WCODE_TEST_MISSING_VAR}"), undefined);
});

test("line number helpers round-trip", () => {
  const lines = ["alpha", "beta", ""];
  const numbered = addLineNumbers(lines, 3);
  assert.match(numbered, /^3  alpha\n4  beta\n5  $/);
  assert.equal(stripLineNumbers(numbered), lines.join("\n"));
});

test("truncateOutput keeps head and tail", () => {
  const big = ("x".repeat(1000) + "\n").repeat(100); // ~101KB
  const out = truncateOutput(big, 5000);
  assert.ok(out.length < big.length);
  assert.match(out, /truncated/);
  assert.ok(out.startsWith("x"));
  assert.ok(out.trimEnd().endsWith("x"));
});

test("edit tool: unique match, replace_all, and error cases", async () => {
  const { createEditTool } = await import("../dist/tools/edit.js");
  const dir = mkdtempSync(join(tmpdir(), "wcode-edit-"));
  const file = join(dir, "f.txt");
  writeFileSync(file, "one two one\nend\n");
  const tool = createEditTool();
  const ctx = {
    cwd: dir,
    readFileState: new Map(),
    requestPermission: async () => true,
  };
  // must read first
  const fail = await tool.execute({ path: file, old_string: "one", new_string: "1" }, ctx).catch((e) => e);
  assert.match(String(fail.message ?? fail), /has not been read/);
  // simulate a prior read
  const { statSync } = await import("node:fs");
  ctx.readFileState.set(file, { hash: "x", mtimeMs: statSync(file).mtimeMs });
  // ambiguity error
  const amb = await tool.execute({ path: file, old_string: "one", new_string: "1" }, ctx).catch((e) => e);
  assert.match(String(amb.message ?? amb), /appears 2 times/);
  // replace_all works
  await tool.execute({ path: file, old_string: "one", new_string: "1", replace_all: true }, ctx);
  assert.equal(readFileSync(file, "utf8"), "1 two 1\nend\n");
  // no-match error with hint
  const nomatch = await tool.execute({ path: file, old_string: "zzz", new_string: "y" }, ctx).catch((e) => e);
  assert.match(String(nomatch.message ?? nomatch), /not found/);
});

test("read tool: line numbers, pagination, read-before-write state", async () => {
  const { createReadTool } = await import("../dist/tools/read.js");
  const dir = mkdtempSync(join(tmpdir(), "wcode-read-"));
  const file = join(dir, "lines.txt");
  writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n") + "\n");
  const tool = createReadTool(false);
  const ctx = { cwd: dir, readFileState: new Map(), requestPermission: async () => true };
  const out = await tool.execute({ path: file }, ctx);
  assert.match(out.content[0].text, /line-1\n/);
  assert.ok(!out.content[0].text.includes("Showing lines"));
  const out2 = await tool.execute({ path: file, offset: 40, limit: 5 }, ctx);
  assert.match(out2.content[0].text, /line-41/); // offset is 0-based
  assert.match(out2.content[0].text, /Use offset=45 to continue/);
  assert.ok(ctx.readFileState.has(file));
});

test("config merge: builtin override + model upsert", async () => {
  const { loadRegistry } = await import("../dist/config.js");
  const dir = mkdtempSync(join(tmpdir(), "wcode-cfg-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      defaultModel: "anthropic/claude-haiku-4-5",
      providers: {
        anthropic: { baseUrl: "https://my-proxy.example.com" },
        custom: {
          api: "openai-completions",
          baseUrl: "http://localhost:9/v1",
          apiKey: "k",
          models: [{ id: "my-model" }, { id: "claude-sonnet-4-5", contextWindow: 7 }],
        },
      },
    }),
  );
  const { config } = { config: null };
  void config;
  const orig = process.env.WCODE_CONFIG;
  process.env.WCODE_CONFIG = join(dir, "config.json");
  try {
    const registry = loadRegistry();
    assert.equal(registry.providers.anthropic.baseUrl, "https://my-proxy.example.com");
    assert.ok(registry.providers.anthropic.models.length >= 3); // built-ins kept
    assert.equal(registry.providers.custom.models.length, 2);
    const overridden = registry.providers.custom.models.find((m) => m.id === "claude-sonnet-4-5");
    assert.equal(overridden.contextWindow, 7); // user model overrides builtin by id
    assert.equal(registry.config.defaultModel, "anthropic/claude-haiku-4-5");
  } finally {
    if (orig === undefined) delete process.env.WCODE_CONFIG;
    else process.env.WCODE_CONFIG = orig;
  }
});

test("e2e: openai-compatible mock — read file via tool, streamed answer", async (t) => {
  const httpServer = mockOpenai.server;
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  t.after(() => {
    httpServer.close();
    httpServer.closeAllConnections?.();
  });
  const port = httpServer.address().port;

  const home = mkdtempSync(join(tmpdir(), "wcode-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-proj-"));
  writeFileSync(join(project, "hello.txt"), "hello from hello.txt\nsecond line\n");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      defaultModel: "mockai/test-model",
      providers: {
        mockai: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "${MOCK_API_KEY}",
          models: [{ id: "test-model", contextWindow: 32000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const env = {
    WCODE_DIR: home,
    MOCK_API_KEY: "mock-key-123",
  };
  const { code, out, err } = await run(["-p", "read hello.txt and tell me what it says", "--yolo"], { cwd: project, env });
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /FILE_SAYS:hello from hello\.txt/);
  // mock saw a valid request with tool result fed back
  assert.ok(mockOpenai.state.requests.length >= 2);
  const second = mockOpenai.state.requests[1];
  assert.ok(second.messages.some((m) => m.role === "tool"));
});

test("session store: append + reload round-trip", async () => {
  const { SessionStore, loadSessionMessages } = await import("../dist/session/store.js");
  const home = mkdtempSync(join(tmpdir(), "wcode-sess-"));
  const orig = process.env.WCODE_DIR;
  process.env.WCODE_DIR = home;
  try {
    const store = new SessionStore("/proj", "test/m1");
    store.record([
      { role: "user", content: [{ type: "text", text: "first question" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
    const { messages, header } = loadSessionMessages(store.filePath);
    assert.equal(header.model, "test/m1");
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content[0].text, "first question");
  } finally {
    if (orig === undefined) delete process.env.WCODE_DIR;
    else process.env.WCODE_DIR = orig;
  }
});

test("e2e: openai mock — write tool creates file", async (t) => {
  const httpServer = mockOpenai.server;
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  t.after(() => {
    httpServer.close();
    httpServer.closeAllConnections?.();
  });
  const port = httpServer.address().port;

  const home = mkdtempSync(join(tmpdir(), "wcode-home2-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-proj2-"));
  // WCODE.md steers the mock: its content lands in the system prompt.
  writeFileSync(join(project, "WCODE.md"), "WRITE-TASK: create agent-output.txt\n");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      providers: {
        mockai: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "mock-key-123",
          models: [{ id: "test-model" }],
        },
      },
    }),
  );
  const { code, out, err } = await run(["-p", "create the file", "--yolo"], {
    cwd: project,
    env: { WCODE_DIR: home },
  });
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /WRITE_DONE/);
  assert.equal(readFileSync(join(project, "agent-output.txt"), "utf8"), "written by wcode agent\n");
});

test("e2e: responses mock — reasoning deltas + function_call round-trip", async (t) => {
  const httpServer = mockResponses.server;
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  t.after(() => {
    httpServer.close();
    httpServer.closeAllConnections?.();
  });
  const port = httpServer.address().port;

  const home = mkdtempSync(join(tmpdir(), "wcode-home6-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-proj6-"));
  writeFileSync(join(project, "hello.txt"), "hello from hello.txt\n");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      providers: {
        mresp: {
          api: "openai-responses",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "mock-key-123",
          models: [{ id: "test-model", contextWindow: 32000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const { code, out, err } = await run(["-p", "read hello.txt", "--yolo", "-m", "mresp/test-model"], {
    cwd: project,
    env: { WCODE_DIR: home },
  });
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /RESPONSES_OK:hello from hello\.txt/);
  // adapter replayed the function_call_output with the right call_id
  const second = mockResponses.state.requests[1];
  const outputItem = second.input.find((i) => i.type === "function_call_output");
  assert.equal(outputItem.call_id, "call_mock_1");
  assert.match(outputItem.output, /hello from hello\.txt/);
});

test("e2e: interactive REPL piped input — permission y consumed, multi-line paste safe", async (t) => {
  const httpServer = mockOpenai.server;
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  t.after(() => {
    httpServer.close();
    httpServer.closeAllConnections?.();
  });
  const port = httpServer.address().port;
  const home = mkdtempSync(join(tmpdir(), "wcode-home8-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-proj8-"));
  // WCODE.md steers the mock into emitting a write tool call.
  writeFileSync(join(project, "WCODE.md"), "WRITE-TASK: create agent-output.txt\n");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      providers: {
        mockai: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "mock-key-123", models: [{ id: "test-model" }] },
      },
    }),
  );
  const child = spawn(process.execPath, [BIN], {
    cwd: project,
    env: { ...process.env, WCODE_DIR: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  // Multi-line task + approvals + exit: the y's must answer the permission
  // prompt (not become prompts themselves), and the process must NOT hang.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 20000);
  child.stdin.end("first task line\nsecond task line\ny\n/exit\n");
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(watchdog);
  assert.notEqual(code, null, "REPL exited on its own (no hang)");
  assert.notEqual(code, 137, "REPL was not SIGKILLed by the watchdog");
  assert.equal(readFileSync(join(project, "agent-output.txt"), "utf8"), "written by wcode agent\n");
  assert.match(out, /WRITE_DONE/);
  // turn-level file change summary (opencode-inspired)
  assert.match(out, /Changed 1 file: agent-output\.txt \(\+2 -0\)/);
  void err;
});

test("e2e: wrong API key surfaces a visible error and nonzero exit", async (t) => {
  const httpServer = mockOpenai.server;
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  t.after(() => {
    httpServer.close();
    httpServer.closeAllConnections?.();
  });
  const port = httpServer.address().port;
  const home = mkdtempSync(join(tmpdir(), "wcode-home7-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      providers: {
        mockai: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "definitely-wrong", models: [{ id: "test-model" }] },
      },
    }),
  );
  const { code, out, err } = await run(["-p", "hi"], { cwd: ROOT, env: { WCODE_DIR: home } });
  assert.equal(code, 1, `stderr: ${err}\nstdout: ${out}`);
  assert.match(err, /error: HTTP 401/);
});

test("e2e: anthropic mock — !command api key, SSE tool_use, json deltas", async (t) => {
  const httpServer = mockAnthropic.server;
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  t.after(() => {
    httpServer.close();
    httpServer.closeAllConnections?.();
  });
  const port = httpServer.address().port;

  const home = mkdtempSync(join(tmpdir(), "wcode-home3-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-proj3-"));
  writeFileSync(join(project, "hello.txt"), "hello from hello.txt\n");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      providers: {
        manthropic: {
          api: "anthropic-messages",
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey: "!echo sk-from-command",
          models: [{ id: "claude-test", contextWindow: 32000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const { code, out, err } = await run(["-p", "read hello.txt", "--yolo", "-m", "manthropic/claude-test"], {
    cwd: project,
    env: { WCODE_DIR: home },
  });
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /ANTHROPIC_OK:hello from hello\.txt/);
  httpServer.close();
  httpServer.closeAllConnections?.();
});

test("e2e: models command and bad model error", async () => {
  const home = mkdtempSync(join(tmpdir(), "wcode-home4-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      defaultModel: "mockai/test-model",
      providers: {
        mockai: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "${SHOULD_BE_UNSET_XYZ}", models: [{ id: "test-model" }] },
      },
    }),
  );
  const noKey = await run(["models"], { env: { WCODE_DIR: home } });
  assert.equal(noKey.code, 0);
  assert.match(noKey.out, /mockai\/test-model/);
  assert.match(noKey.out, /✗/); // unavailable without key
  const bad = await run(["-p", "hi"], { cwd: ROOT, env: { WCODE_DIR: home } });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /no API key for provider "mockai"/);
});

test("e2e: print mode without --yolo declines mutating tools", async (t) => {
  const httpServer = mockOpenai.server;
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  t.after(() => {
    httpServer.close();
    httpServer.closeAllConnections?.();
  });
  const port = httpServer.address().port;
  const home = mkdtempSync(join(tmpdir(), "wcode-home5-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-proj5-"));
  writeFileSync(join(project, "WCODE.md"), "WRITE-TASK: create agent-output.txt\n");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      providers: {
        mockai: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "mock-key-123", models: [{ id: "test-model" }] },
      },
    }),
  );
  const { code, out, err } = await run(["-p", "create the file"], { cwd: project, env: { WCODE_DIR: home } });
  assert.equal(code, 0);
  assert.match(err, /permission denied in print mode/);
  assert.ok(!existsSync(join(project, "agent-output.txt")));
});
