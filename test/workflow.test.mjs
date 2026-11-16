// opencode-inspired workflow tests: retry policy, agent-loop robustness
// (error-stop call dropping, length-continuation guard, overflow recovery),
// steering (mid-run user messages), compaction v2 math, session titles and
// the command-palette fuzzy matcher.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "wcode.js");

// CONFIG_DIR is baked at import time — pin it before any dist import.
const HOME = mkdtempSync(join(tmpdir(), "wcode-flow-home-"));
process.env.WCODE_DIR = HOME;
// Fast retries: the backoff curve is 2s in production.
process.env.WCODE_RETRY_BASE_MS = "1";

// ---------------------------------------------------------------------------

function sse(res, chunks) {
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function textChunk(id, delta, finish = null) {
  return {
    id,
    object: "chat.completion.chunk",
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function toolCallChunk(id, callId, name, args) {
  return textChunk(id, {
    tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: args } }],
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function startServer(handler) {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    void readBody(req).then((body) => {
      const parsed = JSON.parse(body);
      state.requests.push(parsed);
      try {
        handler(req, res, parsed, state);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

function makeHome(name, port, modelExtras = {}) {
  const home = mkdtempSync(join(tmpdir(), `wcode-${name}-home-`));
  const project = mkdtempSync(join(tmpdir(), `wcode-${name}-proj-`));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      defaultModel: "mockai/test-model",
      providers: {
        mockai: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "mock-key-123",
          models: [{ id: "test-model", contextWindow: 32000, maxTokens: 4096, ...modelExtras }],
        },
      },
    }),
  );
  return { home, project };
}

function repl(env, inputs, timeoutMs = 25000) {
  const child = spawn(process.execPath, [BIN], {
    cwd: env.project,
    env: { ...process.env, WCODE_DIR: env.home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const watchdog = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.stdin.end(inputs);
  return new Promise((resolve) =>
    child.on("close", (code) => {
      clearTimeout(watchdog);
      resolve({ code, out, err });
    }),
  );
}

/** Unit-level Agent against a mock server (no CLI, no session store). */
async function makeAgent(port, tools = []) {
  const { Agent } = await import("../dist/agent/agent.js");
  const model = {
    key: "mockai/test-model",
    providerId: "mockai",
    provider: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1` },
    model: { id: "test-model", contextWindow: 32000, maxTokens: 4096 },
    apiKey: "mock-key-123",
    headers: {},
  };
  return new Agent({
    cwd: tmpdir(),
    model,
    system: "test system",
    tools,
    policy: "yolo",
    requestPermission: async () => true,
  });
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test("retry: recovers from a 500, cancels the rejected body, reports attempts", async () => {
  const { AdapterBase } = await import("../dist/ai/adapter-base.js");
  let cancelled = false;
  let calls = 0;
  const onRetry = [];
  const fakeResponse = (ok, status, body = "{}") => ({
    ok,
    status,
    statusText: "teapot",
    headers: new Map(),
    body: { cancel: async () => (cancelled = true) },
    text: async () => body,
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? fakeResponse(false, 500) : fakeResponse(true, 200);
  };
  try {
    class T extends AdapterBase {}
    const t = new T();
    const res = await t.fetchWithRetry(
      "http://127.0.0.1:1/x",
      { method: "POST" },
      undefined,
      (status) => status >= 500,
      (attempt, delay, reason) => onRetry.push({ attempt, delay, reason }),
    );
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    assert.equal(cancelled, true, "rejected body must be cancelled before sleeping");
    assert.deepEqual(onRetry.map((r) => r.attempt), [1]);
    assert.ok(onRetry[0].reason.includes("500"));
    assert.ok(onRetry[0].delay >= 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("retry: gives up after MAX_ATTEMPTS with the last error", async () => {
  const { AdapterBase, ApiError } = await import("../dist/ai/adapter-base.js");
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false,
      status: 503,
      statusText: "unavailable",
      headers: new Map(),
      body: { cancel: () => {} },
      text: async () => JSON.stringify({ error: { message: "overloaded" } }),
    };
  };
  try {
    class T extends AdapterBase {}
    const t = new T();
    await assert.rejects(
      t.fetchWithRetry("http://127.0.0.1:1/x", { method: "POST" }, undefined, (status) => status >= 500),
      (err) => err instanceof ApiError && err.message.includes("overloaded"),
    );
    assert.equal(calls, 5, "MAX_ATTEMPTS = 5 (opencode model-retry)");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// Compaction v2 math
// ---------------------------------------------------------------------------

test("compaction: reserve-based ceiling and user-anchored tail split", async () => {
  const { compactionCeiling, splitForCompaction } = await import("../dist/agent/compact.js");
  assert.equal(compactionCeiling(200_000), 170_000, "200k − max(15%, 16k)");
  assert.equal(compactionCeiling(1000), 850, "small window: 15% share only");
  assert.equal(compactionCeiling(undefined), 100_000, "unknown window fallback");

  const big = "x".repeat(8000); // ~2000 tokens per message
  const messages = [
    { role: "user", content: [{ type: "text", text: "first task" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "read", arguments: "{}" }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "c1", content: [{ type: "text", text: big }] }] },
    { role: "assistant", content: [{ type: "text", text: "mid answer" }] },
    { role: "user", content: [{ type: "text", text: "second task" }] },
    { role: "assistant", content: [{ type: "text", text: big }] },
    { role: "user", content: [{ type: "text", text: "third task" }] },
  ];
  const { head, tail } = splitForCompaction(messages, 4000);
  assert.ok(head.length >= 1, "head is never empty");
  assert.ok(tail.length >= 1, "tail is never empty");
  assert.equal(head.length + tail.length, messages.length, "split preserves every message");
  // The tail must not open with orphaned tool results: the pair stays whole.
  assert.equal(tail[0].content.some((b) => b.type === "tool_result"), false, "tail never starts on a tool result");
  const tailTexts = tail.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
  const headCalls = head.flatMap((m) => m.content).filter((b) => b.type === "tool_call");
  const headIds = new Set(headCalls.map((b) => b.id));
  for (const result of tailTexts) {
    assert.equal(headIds.has(result.toolCallId), false, "kept tool results belong to kept calls");
  }
});

// ---------------------------------------------------------------------------
// Command palette fuzzy matcher
// ---------------------------------------------------------------------------

test("fuzzy: subsequence scoring with prefix and word bonuses", async () => {
  const { fuzzyScore, fuzzyFilter } = await import("../dist/ui/fuzzy.js");
  assert.equal(fuzzyScore("xyz", "commands"), null, "no match → null");
  assert.equal(fuzzyScore("", "anything"), 0);
  const prefix = fuzzyScore("comp", "compact");
  const spread = fuzzyScore("comp", "cxoxmxpxaxctx");
  assert.ok(prefix > spread, "prefix match outranks scattered match");
  const items = [
    { name: "sessions" },
    { name: "cost" },
    { name: "compact" },
  ];
  const filtered = fuzzyFilter(items, "comp", (i) => i.name);
  assert.deepEqual(filtered.map((i) => i.name), ["compact"]);
  const all = fuzzyFilter(items, "", (i) => i.name);
  assert.equal(all.length, 3, "empty query passes everything through");
});

// ---------------------------------------------------------------------------
// Steer: mid-run user injection (Agent-level; the TUI submits through it)
// ---------------------------------------------------------------------------

test("steer: text submitted mid-run reaches the next request and gets answered", async () => {
  const { server, state, port } = await startServer((req, res, parsed) => {
    const hasSteer = JSON.stringify(parsed.messages).includes("followup: focus on tests");
    if (state.requests.length === 1) {
      // Slow first response so the steer lands while the agent is busy.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        sse(res, [textChunk("id", { role: "assistant", content: "first answer" }), textChunk("id", {}, "stop")]);
      }, 300);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (hasSteer) sse(res, [textChunk("id", { role: "assistant", content: "STEER_SEEN" }), textChunk("id", {}, "stop")]);
    else sse(res, [textChunk("id", { role: "assistant", content: "STEER_MISSING" }), textChunk("id", {}, "stop")]);
  });
  try {
    const agent = await makeAgent(port);
    const events = [];
    const run = agent.run("hello", (e) => events.push(e));
    // The first response takes ~300ms; steer at ~100ms while it streams.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(agent.steer("followup: focus on tests"), true, "agent is busy → steer accepted");
    await run;
    assert.equal(state.requests.length, 2, "steer forces one more turn");
    const second = JSON.stringify(state.requests[1].messages);
    assert.ok(second.includes("followup: focus on tests"), "steer text is in the transcript");
    const texts = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    assert.ok(texts.includes("STEER_SEEN"));
  } finally {
    server.close();
  }
});

test("steer: rejected when the agent is idle", async () => {
  const agent = await makeAgent(1); // no server needed — never runs
  assert.equal(agent.steer("nope"), false);
});

// ---------------------------------------------------------------------------
// Agent-loop robustness
// ---------------------------------------------------------------------------

test("loop: a stream error after partial tool calls drops them, retries transiently, never executes", async () => {
  const { server, state, port } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Stream a tool call, then kill the connection mid-stream. Every attempt
    // dies the same way: the run ends after the initial try + 2 retries.
    res.write(`data: ${JSON.stringify(textChunk("id", { role: "assistant", content: "working" }))}\n\n`);
    res.write(`data: ${JSON.stringify(toolCallChunk("id", "call_1", "bash", '{"command": "echo hacked"}'))}\n\n`);
    setTimeout(() => res.destroy(), 20);
  });
  try {
    let executed = false;
    const tools = [
      {
        name: "bash",
        description: "run",
        readOnly: false,
        parameters: { type: "object", properties: {} },
        execute: async () => {
          executed = true;
          return { content: [{ type: "text", text: "ran" }], display: "ran" };
        },
      },
    ];
    const agent = await makeAgent(port, tools);
    const events = [];
    await agent.run("go", (e) => events.push(e));
    assert.equal(executed, false, "half-streamed tool calls must never execute, on any attempt");
    assert.equal(state.requests.length, 3, "transient stream failures retry twice before surfacing");
    const errors = events.filter((e) => e.type === "error");
    assert.ok(errors.length >= 1);
    const retries = events.filter((e) => e.type === "notice" && /retrying after interrupted stream/.test(e.message));
    assert.equal(retries.length, 2, "each retry is announced");
  } finally {
    server.close();
  }
});

test("loop: a hard provider error (HTTP 400) ends the run without retrying", async () => {
  const { server, state, port } = await startServer((req, res) => {
    // A non-retryable status: the adapter surfaces it once, nothing retries.
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid request: bad schema" } }));
  });
  try {
    const agent = await makeAgent(port, []);
    const events = [];
    await agent.run("go", (e) => events.push(e));
    assert.equal(state.requests.length, 1, "a hard provider error is not retried");
    const error = events.find((e) => e.type === "error");
    assert.ok(error, "the failure is surfaced");
    assert.match(error.errorMessage, /invalid request: bad schema/);
  } finally {
    server.close();
  }
});

test("loop: endless length truncation fails after two continuations", async () => {
  const { server, state, port } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, [textChunk("id", { role: "assistant", content: "truncated..." }), textChunk("id", {}, "length")]);
  });
  try {
    const agent = await makeAgent(port);
    const events = [];
    await agent.run("go", (e) => events.push(e));
    assert.equal(state.requests.length, 3, "initial + 2 continuations");
    const errors = events.filter((e) => e.type === "error").map((e) => e.errorMessage);
    assert.ok(errors.some((m) => m.includes("still truncated after two continuations")));
  } finally {
    server.close();
  }
});

test("loop: context-overflow rejection recovers via prune and retries the turn", async () => {
  // Read results ≈ 13k tokens each; five of them overflow the 240k-char prune
  // protection so recovery has something to clear. Window 200k → the 60%
  // prune trigger never fires pre-request.
  const { server, state, port } = await startServer((req, res, parsed) => {
    const toolResults = parsed.messages.filter((m) => m.role === "tool").length;
    if (toolResults < 5) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, [
        textChunk("id", { role: "assistant", content: "reading" }),
        toolCallChunk("id", `call_${toolResults + 1}`, "read", '{"path": "big.txt"}'),
        textChunk("id", {}, "tool_calls"),
      ]);
      return;
    }
    if (toolResults === 5 && state.requests.length === 6) {
      // First arrival at full context: provider rejects.
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "prompt is too long: 150000 tokens > 100000 maximum" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, [textChunk("id", { role: "assistant", content: "RECOVERED_OK" }), textChunk("id", {}, "stop")]);
  });
  try {
    const { Agent } = await import("../dist/agent/agent.js");
    const { createTools } = await import("../dist/tools/index.js");
    const model = {
      key: "mockai/test-model",
      providerId: "mockai",
      provider: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1` },
      model: { id: "test-model", contextWindow: 200000, maxTokens: 4096 },
      apiKey: "mock-key-123",
      headers: {},
    };
    const project = mkdtempSync(join(tmpdir(), "wcode-ovf-proj-"));
    // 600 lines × 200 chars = 120k chars before the read tool's output cap.
    writeFileSync(join(project, "big.txt"), Array.from({ length: 600 }, () => "y".repeat(200)).join("\n") + "\n");
    const tools = createTools({ supportsImages: false, policy: "yolo" });
    const agent = new Agent({
      cwd: project,
      model,
      system: "test",
      tools,
      policy: "yolo",
      requestPermission: async () => true,
    });
    const events = [];
    await agent.run("read big.txt a few times", (e) => events.push(e));
    assert.equal(state.requests.length, 7, "6th request rejected → prune → 7th succeeds");
    const notices = events.filter((e) => e.type === "notice").map((e) => e.message);
    assert.ok(notices.some((m) => m.includes("context overflow")), "recovery is announced");
    const texts = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    assert.ok(texts.includes("RECOVERED_OK"));
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Theme system
// ---------------------------------------------------------------------------

test("theme: three built-ins, unknown rejected, active name tracked", async () => {
  const { listThemes, applyTheme, activeThemeName, initTheme } = await import("../dist/ui/theme.js");
  const names = listThemes().map((t) => t.name);
  assert.deepEqual(names.sort(), ["mono", "wcode-dark", "wcode-light"]);
  assert.equal(applyTheme("nope"), false);
  assert.equal(activeThemeName(), "wcode-dark", "failed switch keeps the current theme");
  assert.equal(applyTheme("wcode-light"), true);
  assert.equal(activeThemeName(), "wcode-light");
  // Startup selection: saved wins; without one, COLORFGBG decides (default dark).
  initTheme("mono");
  assert.equal(activeThemeName(), "mono");
  initTheme(undefined);
  assert.ok(["wcode-dark", "wcode-light"].includes(activeThemeName()));
  applyTheme("wcode-dark");
});

// ---------------------------------------------------------------------------
// Secret-file guard (opencode default permission: read *.env → ask)
// ---------------------------------------------------------------------------

test("env guard: .env asks even in yolo, .env.example exempt, explicit allow wins", async () => {
  const { runTool, createTools } = await import("../dist/tools/index.js");
  const project = mkdtempSync(join(tmpdir(), "wcode-env-"));
  writeFileSync(join(project, ".env"), "SECRET=1\n");
  writeFileSync(join(project, ".env.example"), "TEMPLATE=1\n");
  const tools = createTools({ supportsImages: false, policy: "yolo" });
  const ctx = (asks) => ({
    cwd: project,
    readFileState: new Map(),
    requestPermission: async () => {
      asks.push(1);
      return true;
    },
    onUpdate: () => {},
  });

  const asks = [];
  const res = await runTool(tools, "read", { path: ".env" }, ctx(asks), "yolo");
  assert.equal(asks.length, 1, "reading .env asks even in yolo mode");
  assert.match(res.output.content[0].text, /SECRET=1/);

  const asks2 = [];
  const res2 = await runTool(tools, "read", { path: ".env.example" }, ctx(asks2), "yolo");
  assert.equal(asks2.length, 0, ".env.example is exempt");
  assert.match(res2.output.content[0].text, /TEMPLATE=1/);

  // Denial path: the tool result is an error the model can act on.
  const res3 = await runTool(tools, "read", { path: ".env" }, { cwd: project, readFileState: new Map(), requestPermission: async () => false, onUpdate: () => {} }, "yolo");
  assert.equal(res3.isError, true);
  assert.match(res3.output.content[0].text, /was denied/);
});

// ---------------------------------------------------------------------------
// E2E: settings hot reload applies a deny rule mid-session
// ---------------------------------------------------------------------------

test("e2e: settings hot reload — a deny rule written mid-session blocks the next call", async () => {
  const { server, state, port } = await startServer((req, res, parsed) => {
    // The LAST message decides: a fresh user prompt gets a bash call; a tool
    // result gets the verdict for THAT call (each run may add its own result).
    const last = parsed.messages[parsed.messages.length - 1];
    if (last?.role !== "tool") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, [
        textChunk("id", { role: "assistant", content: "running" }),
        toolCallChunk("id", `call_bash_${state.requests.length}`, "bash", '{"command": "echo hotmark"}'),
        textChunk("id", {}, "tool_calls"),
      ]);
      return;
    }
    const denied = (last.content ?? "").includes("denied by a permission rule");
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, [textChunk("id", { role: "assistant", content: denied ? "HOT_DENIED_OK" : `HOT_RAW:${(last.content ?? "").slice(0, 120)}` }), textChunk("id", {}, "stop")]);
  });
  const env = makeHome("hot", port);
  try {
    const child = spawn(process.execPath, [BIN, "--yolo"], {
      cwd: env.project,
      env: { ...process.env, WCODE_DIR: env.home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 25000);
    child.stdin.write("run it once\n");
    // Wait for the first (allowed) run to complete before changing settings.
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const poll = () => {
        if (out.includes("HOT_RAW:hotmark")) return resolve();
        if (Date.now() > deadline) return reject(new Error(`first run never completed: ${out.slice(0, 200)}`));
        setTimeout(poll, 100);
      };
      poll();
    });
    mkdirSync(join(env.project, ".wcode"), { recursive: true });
    await new Promise((r) => setTimeout(r, 400)); // let the watcher arm on the new dir
    writeFileSync(join(env.project, ".wcode", "settings.json"), JSON.stringify({ permissions: { deny: ["bash(echo *)"] } }));
    await new Promise((r) => setTimeout(r, 800)); // debounce (100ms) + reload
    child.stdin.write("run it again\n/exit\n");
    child.stdin.end();
    const code = await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(watchdog);
    assert.equal(code, 0);
    assert.ok(out.includes("HOT_RAW:hotmark"), "first call ran (no rules yet)");
    assert.ok(out.includes("HOT_DENIED_OK"), `second call was blocked by the reloaded rule — FULL OUT:\n${out}\nFULL ERR:\n${err}`);
    assert.ok(state.requests.length >= 4);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// E2E: the env guard reaches real sessions (yolo still asks for .env)
// ---------------------------------------------------------------------------

test("e2e: reading .env asks in a yolo session; y approves, EOF denies", async () => {
  const { server, state, port } = await startServer((req, res, parsed) => {
    const hasTool = parsed.messages.some((m) => m.role === "tool");
    if (!hasTool) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, [
        textChunk("id", { role: "assistant", content: "reading" }),
        toolCallChunk("id", "call_env", "read", '{"path": ".env"}'),
        textChunk("id", {}, "tool_calls"),
      ]);
      return;
    }
    const toolMsg = parsed.messages.find((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    if ((toolMsg?.content ?? "").includes("denied")) {
      sse(res, [textChunk("id", { role: "assistant", content: "ENV_DENIED" }), textChunk("id", {}, "stop")]);
    } else {
      const secret = (toolMsg?.content ?? "").match(/SECRET=1/)?.[0] ?? "no-secret";
      sse(res, [textChunk("id", { role: "assistant", content: `ENV_SEEN:${secret}` }), textChunk("id", {}, "stop")]);
    }
  });
  const env = makeHome("envtask", port);
  try {
    writeFileSync(join(env.project, ".env"), "SECRET=1\n");
    // Approved path: the queued "y" answers the guard's ask.
    const ok = await repl({ ...env }, "show secrets\ny\n/exit\n");
    assert.ok(ok.out.includes("ENV_SEEN:SECRET=1"), `approved read reaches the model — out: ${ok.out.slice(0, 300)}`);
    // Denied path: stdin already closed when the ask fires → deny.
    const denied = await repl({ ...env }, "show secrets\n/exit\n");
    assert.ok(denied.out.includes("ENV_DENIED"), `EOF on the ask denies — out: ${denied.out.slice(0, 300)}`);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// E2E: auto-compact v2 (summary + kept tail), session title, /sessions listing
// ---------------------------------------------------------------------------

test("e2e: auto-compact keeps a summary + recent tail; the session gets a title", async () => {
  const { server, state, port } = await startServer((req, res, parsed) => {
    const system = parsed.messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("conversation titles")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, [textChunk("id", { role: "assistant", content: 'The Big Refactor' }), textChunk("id", {}, "stop")]);
      return;
    }
    if (!parsed.tools || parsed.tools.length === 0) {
      // summarizer call
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, [
        textChunk("id", { role: "assistant", content: "SUMMARY: the agent read big notes repeatedly." }),
        textChunk("id", {}, "stop"),
      ]);
      return;
    }
    const transcript = JSON.stringify(parsed.messages);
    const toolResults = parsed.messages.filter((m) => m.role === "tool").length;
    if (toolResults < 3) {
      // Three read rounds build an 8-message transcript (compact needs ≥ 8).
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, [
        textChunk("id", { role: "assistant", content: "reading" }),
        toolCallChunk("id", `call_${toolResults + 1}`, "read", '{"path": "notes.txt"}'),
        textChunk("id", {}, "tool_calls"),
      ]);
      return;
    }
    if (!transcript.includes("context_summary")) {
      // Second prompt, before compaction: answer normally.
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, [textChunk("id", { role: "assistant", content: "PRE_COMPACT_OK" }), textChunk("id", {}, "stop")]);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, [textChunk("id", { role: "assistant", content: "POST_COMPACT_OK" }), textChunk("id", {}, "stop")]);
  });

  const env = makeHome("compact", port, { contextWindow: 32000 });
  try {
    // notes.txt ≈ 24k chars ≈ 6k tokens per read result. Window 32k → prune
    // trigger 19.2k (never fires: 3 results ≈ 18k), reserve ceiling 16k →
    // the second prompt crosses it and auto-compact fires.
    writeFileSync(join(env.project, "notes.txt"), (Array.from({ length: 24 }, () => "n".repeat(1000)).join("\n") + "\n"));
    const res = await repl(env, "start\nagain\n/sessions\n/exit\n");
    assert.ok(res.out.includes("auto-compact"), `auto-compact notice printed — out: ${res.out.slice(0, 500)} · err: ${res.err.slice(0, 300)}`);
    assert.ok(res.out.includes("PRE_COMPACT_OK"), "first exchange completes normally");
    assert.ok(res.out.includes("POST_COMPACT_OK"), "post-compact turn answers");
    assert.ok(res.out.includes("The Big Refactor"), "/sessions lists the generated title");

    // The newest session file holds the summary + title + kept tail.
    const sessionsDir = join(env.home, "sessions");
    const file = readdirSync(sessionsDir).map((f) => join(sessionsDir, f))[0];
    const raw = readFileSync(file, "utf8");
    assert.ok(raw.includes("<context_summary>"), "transcript rewritten with a summary");
    assert.ok(raw.includes("SUMMARY: the agent read big notes repeatedly."));
    assert.ok(raw.includes('"type":"title"'));
    assert.ok(raw.includes("The Big Refactor"));
    assert.ok(state.requests.length >= 6);
  } finally {
    server.close();
    process.env.WCODE_DIR = HOME;
  }
});

// ---------------------------------------------------------------------------
// Anthropic prompt caching + cache-aware cost accounting
// ---------------------------------------------------------------------------

/** Anthropic-protocol agent against a mock /v1/messages endpoint. */
async function makeAnthropicAgent(port, tools = [], providerExtras = {}) {
  const { Agent } = await import("../dist/agent/agent.js");
  const model = {
    key: "mockant/claude-test",
    providerId: "mockant",
    provider: { api: "anthropic-messages", baseUrl: `http://127.0.0.1:${port}`, ...providerExtras },
    model: { id: "claude-test", contextWindow: 32000, maxTokens: 4096 },
    apiKey: "sk-ant-test",
    headers: {},
  };
  return new Agent({
    cwd: tmpdir(),
    model,
    system: "cached system prompt",
    tools,
    policy: "yolo",
    requestPermission: async () => true,
  });
}

function anthropicTextSse(res, text) {
  const frames = [
    ["message_start", { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 10 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  for (const [event, data] of frames) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

test("anthropic: prompt-cache breakpoints land on tools, system and the last message", async () => {
  const { server, state, port } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    anthropicTextSse(res, "hi there");
  });
  try {
    const tools = [
      { name: "read", description: "r", readOnly: true, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "" }], display: "" }) },
      { name: "bash", description: "b", readOnly: false, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "" }], display: "" }) },
    ];
    const agent = await makeAnthropicAgent(port, tools);
    await agent.run("hello", () => {});
    assert.equal(state.requests.length, 1);
    const body = state.requests[0];

    // tools: breakpoint on the last tool only
    assert.equal(body.tools.length, 2);
    assert.equal(body.tools[0].cache_control, undefined);
    assert.deepEqual(body.tools[1].cache_control, { type: "ephemeral" });

    // system: one cached text block
    assert.ok(Array.isArray(body.system), "system becomes a block array when caching");
    assert.equal(body.system[0].text, "cached system prompt");
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });

    // messages: the final block of the last message carries the breakpoint
    const last = body.messages[body.messages.length - 1];
    const lastBlock = last.content[last.content.length - 1];
    assert.deepEqual(lastBlock.cache_control, { type: "ephemeral" });
    assert.equal(lastBlock.type, "text");
    assert.equal(lastBlock.text, "hello");
  } finally {
    server.close();
  }
});

test("anthropic: promptCaching:false strips every breakpoint (proxy escape hatch)", async () => {
  const { server, state, port } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    anthropicTextSse(res, "hi there");
  });
  try {
    const tools = [
      { name: "read", description: "r", readOnly: true, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "" }], display: "" }) },
    ];
    const agent = await makeAnthropicAgent(port, tools, { promptCaching: false });
    await agent.run("hello", () => {});
    const body = state.requests[0];
    assert.equal(typeof body.system, "string", "system stays a plain string");
    assert.equal(body.tools[0].cache_control, undefined);
    for (const m of body.messages) {
      for (const b of m.content) assert.equal(b.cache_control, undefined);
    }
  } finally {
    server.close();
  }
});

test("cost: cache tokens priced per protocol semantics", async () => {
  const { computeTurnCost } = await import("../dist/agent/agent.js");
  // Anthropic: input_tokens excludes cached tokens — all three are billed.
  const anthropic = computeTurnCost(
    { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10_000, cacheWriteTokens: 2_000 },
    { input: 3, output: 15 },
    "anthropic-messages",
  );
  // 100·3/M + 50·15/M + 10k·0.3/M + 2k·3.75/M
  assert.ok(Math.abs(anthropic - (0.0003 + 0.00075 + 0.003 + 0.0075)) < 1e-12, `anthropic cost ${anthropic}`);

  // OpenAI: prompt_tokens includes cached tokens — subtract before billing.
  const openai = computeTurnCost(
    { inputTokens: 10_100, outputTokens: 50, cacheReadTokens: 10_000 },
    { input: 3, output: 15 },
    "openai-completions",
  );
  // (10_100 − 10_000)·3/M + 10_000·0.3/M + 50·15/M
  assert.ok(Math.abs(openai - (0.0003 + 0.003 + 0.00075)) < 1e-12, `openai cost ${openai}`);

  // Explicit rates win over the multipliers.
  const explicit = computeTurnCost(
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
    { input: 3, output: 15, cacheRead: 0.3 },
    "anthropic-messages",
  );
  assert.ok(Math.abs(explicit - 0.3) < 1e-12, `explicit rate ${explicit}`);

  // No pricing configured → zero, never NaN.
  assert.equal(computeTurnCost({ inputTokens: 5, outputTokens: 5 }), 0);
});

test("anthropic: real usage in message_delta (zhipu-style) is adopted", async () => {
  const { server, state, port } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // zhipu's anthropic-compatible endpoint: message_start carries zeros,
    // message_delta carries the real input/output/cache numbers.
    const frames = [
      ["message_start", { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 0, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 51, output_tokens: 32, cache_read_input_tokens: 17 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    for (const [event, data] of frames) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  try {
    const agent = await makeAnthropicAgent(port, []);
    const events = [];
    await agent.run("hello", (e) => events.push(e));
    const end = events.find((e) => e.type === "message_end");
    assert.ok(end, "the turn completes");
    assert.deepEqual(end.message.usage, { inputTokens: 51, outputTokens: 32, cacheReadTokens: 17 });
    const turn = events.find((e) => e.type === "turn_end");
    assert.equal(turn.totalUsage.inputTokens, 51, "token totals no longer read zero");
  } finally {
    server.close();
  }
});
