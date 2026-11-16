// Tests for the newer feature set: permission rules, settings, custom slash
// commands, MCP client, web tools, auto-compact, store rewrite, and the
// /rewind //export /status controller commands. E2E pieces run the real CLI
// against the mock OpenAI server (scripted scenarios) and the stdio MCP mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import mockOpenai from "./mock-openai.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "wcode.js");

// CONFIG_DIR is baked at import time — pin it before any dist import.
const HOME = mkdtempSync(join(tmpdir(), "wcode-feat-home-"));
process.env.WCODE_DIR = HOME;
// Shrink the safety nets BEFORE the first dist import loads the constants:
// 1s stream-idle abort, 100ms subagent heartbeat (stall tests below).
process.env.WCODE_STREAM_IDLE_MS = "1000";
process.env.WCODE_TASK_HEARTBEAT_MS = "100";

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

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

test("permission rules: parse, match, gate precedence", async () => {
  const { parseRule, ruleMatches, PermissionGate, permissionSubject } = await import("../dist/permissions.js");

  assert.deepEqual(parseRule("write"), { tool: "write" });
  assert.deepEqual(parseRule("bash(git *)"), { tool: "bash", pattern: "git *" });
  assert.equal(parseRule("bad (rule)"), null);
  assert.equal(parseRule(""), null);

  const bashGit = parseRule("bash(git *)");
  assert.equal(ruleMatches(bashGit, "bash", "git status"), true);
  assert.equal(ruleMatches(bashGit, "bash", "git push --force"), true);
  assert.equal(ruleMatches(bashGit, "bash", "echo git status"), false);
  assert.equal(ruleMatches(parseRule("read"), "read", undefined), true);

  const gate = new PermissionGate(["bash(git *)", "read"], ["bash(rm -rf *)"]);
  assert.equal(gate.decide("bash", "git status"), "allow");
  assert.equal(gate.decide("bash", "rm -rf /"), "deny");
  assert.equal(gate.decide("bash", "ls -la"), "ask");
  assert.equal(gate.decide("read"), "allow");
  assert.equal(gate.decide("write"), "ask");
  // deny wins even when an allow rule also matches
  const both = new PermissionGate(["bash(*)"], ["bash(danger*)"]);
  assert.equal(both.decide("bash", "danger-zone"), "deny");
  assert.equal(both.isEmpty, false);
  assert.equal(new PermissionGate().isEmpty, true);
  assert.equal(gate.matchedDeny("bash", "rm -rf /"), "bash(rm -rf *)");

  // path subjects are relativized to the cwd
  assert.equal(permissionSubject("edit", { path: "/a/b/c.ts" }, "/a/b"), "c.ts");
  assert.equal(permissionSubject("edit", { path: "/a/b/c.ts" }, "/x/y"), "/a/b/c.ts");
  assert.equal(permissionSubject("bash", { command: "make all" }, "/x"), "make all");
  assert.equal(permissionSubject("read", { path: "rel.ts" }, "/x"), "rel.ts");
});

test("runTool: deny blocks even under yolo; allow skips the ask", async () => {
  const { runTool } = await import("../dist/tools/index.js");
  const { createTools } = await import("../dist/tools/index.js");
  const { PermissionGate } = await import("../dist/permissions.js");
  const dir = mkdtempSync(join(tmpdir(), "wcode-gate-"));
  const tools = createTools({ supportsImages: false, policy: "yolo" });
  const ctx = { cwd: dir, readFileState: new Map(), requestPermission: async () => true };

  const denyGate = new PermissionGate([], ["bash(echo blocked-*)"]);
  const denied = await runTool(tools, "bash", { command: "echo blocked-command" }, ctx, "yolo", denyGate);
  assert.equal(denied.isError, true);
  assert.match(denied.output.content[0].text, /denied by a permission rule/);
  // a non-matching command still runs under yolo
  const ok = await runTool(tools, "bash", { command: "echo free-command" }, ctx, "yolo", denyGate);
  assert.equal(ok.isError, false);
  assert.match(ok.output.content[0].text, /free-command/);

  // allow rule auto-approves even when the asker would refuse
  const allowGate = new PermissionGate(["bash(echo allowed-*)"], []);
  const refusing = { cwd: dir, readFileState: new Map(), requestPermission: async () => false };
  const allowed = await runTool(tools, "bash", { command: "echo allowed-run" }, refusing, "ask", allowGate);
  assert.equal(allowed.isError, false);
  assert.match(allowed.output.content[0].text, /allowed-run/);
});

test("settings: user + project merge with comments", async () => {
  const { loadSettings } = await import("../dist/settings.js");
  const cwd = mkdtempSync(join(tmpdir(), "wcode-set-"));
  writeFileSync(join(HOME, "settings.json"), '{\n // user rules\n "permissions": { "allow": ["read"], "deny": ["bash(rm *)"] } }');
  mkdirSync(join(cwd, ".wcode"));
  writeFileSync(join(cwd, ".wcode", "settings.json"), '{ "permissions": { "allow": ["bash(git *)"] } }');
  const { settings, paths } = loadSettings(cwd);
  assert.equal(paths.length, 2);
  assert.deepEqual(settings.allow.sort(), ["bash(git *)", "read"]);
  assert.deepEqual(settings.deny, ["bash(rm *)"]);
  // broken project file must not brick the session
  writeFileSync(join(cwd, ".wcode", "settings.json"), "{ not json");
  const { settings: s2 } = loadSettings(cwd);
  assert.deepEqual(s2.allow, ["read"]);
});

// ---------------------------------------------------------------------------
// Custom slash commands
// ---------------------------------------------------------------------------

test("custom commands: frontmatter, $ARGUMENTS, project shadows user", async () => {
  const { loadCustomCommands, expandCommand } = await import("../dist/commands.js");
  const cwd = mkdtempSync(join(tmpdir(), "wcode-cmd-"));
  mkdirSync(join(cwd, ".wcode", "commands"), { recursive: true });
  mkdirSync(join(HOME, "commands"), { recursive: true });
  writeFileSync(
    join(cwd, ".wcode", "commands", "review.md"),
    '---\ndescription: Review the diff\nargument-hint: [pr]\n---\nReview $ARGUMENTS carefully.',
  );
  writeFileSync(join(HOME, "commands", "review.md"), "user version $ARGUMENTS");
  writeFileSync(join(HOME, "commands", "deploy.md"), "Ship it.");
  writeFileSync(join(cwd, ".wcode", "commands", "notes.md"), "project only");

  const cmds = loadCustomCommands(cwd);
  assert.deepEqual(cmds.map((c) => c.name), ["deploy", "notes", "review"]);
  const review = cmds.find((c) => c.name === "review");
  assert.equal(review.description, "Review the diff");
  assert.equal(review.argumentHint, "[pr]");
  assert.equal(review.source, "project");
  assert.equal(expandCommand(review, "PR #42"), "Review PR #42 carefully.");
  assert.equal(expandCommand(review, ""), "Review  carefully.");

  const deploy = cmds.find((c) => c.name === "deploy");
  assert.equal(deploy.source, "user");
  // no placeholder → args appended as a section
  assert.equal(expandCommand(deploy, "prod"), "Ship it.\n\n<arguments>\nprod\n</arguments>");
  assert.equal(expandCommand(deploy, ""), "Ship it.");
});

// ---------------------------------------------------------------------------
// Web tools
// ---------------------------------------------------------------------------

test("web: htmlToText, entities, ddg result parsing", async () => {
  const { htmlToText, decodeEntities, parseDdgResults } = await import("../dist/tools/web.js");
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &#65;&#x42;"), "a & b <c> AB");
  const text = htmlToText("<html><head><style>x{}</style></head><body><h1>Title</h1><p>Para one &amp; two</p><ul><li>item</li></ul><script>evil()</script></body></html>");
  assert.match(text, /Title/);
  assert.match(text, /Para one & two/);
  assert.match(text, /- item/);
  assert.doesNotMatch(text, /evil\(\)/);

  const ddg = [
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=xyz">Example <b>Site</b></a>',
    '<a class="result__snippet" href="#">A <em>snippet</em> here</a>',
    '<a rel="nofollow" class="result__a" href="https://direct.com">Direct</a>',
  ].join("");
  const results = parseDdgResults(ddg);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/a");
  assert.equal(results[0].title, "Example Site");
  assert.match(results[0].snippet, /snippet/);
  assert.equal(results[1].url, "https://direct.com");
});

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

test("mcp: client handshake, tools/list, tools/call over stdio", async () => {
  const { McpClient } = await import("../dist/mcp/client.js");
  const client = await McpClient.connect("testsrv", { command: process.execPath, args: [join(ROOT, "test", "mock-mcp.mjs")] });
  try {
    assert.ok(client.alive);
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["echo", "ping"]);
    assert.match(tools[0].description, /Echo/);
    const res = await client.callTool("echo", { text: "hello-mcp" });
    assert.equal(res.content[0].text, "echo:hello-mcp");
    const res2 = await client.callTool("ping", {});
    assert.equal(res2.content[0].text, "pong");
  } finally {
    client.close();
  }
});

test("mcp: server config loading merges user config and project .mcp.json", async () => {
  const { loadMcpServers } = await import("../dist/mcp/index.js");
  const { loadRegistry } = await import("../dist/config.js");
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({ providers: {}, mcpServers: { alpha: { command: "cmd-a" }, shared: { command: "user-shared" } } }),
  );
  const cwd = mkdtempSync(join(tmpdir(), "wcode-mcp-"));
  writeFileSync(join(cwd, ".mcp.json"), '{ "mcpServers": { "beta": { "command": "cmd-b" }, "shared": { "command": "project-shared" } } }');
  const registry = loadRegistry();
  const entries = loadMcpServers(cwd, registry);
  const byName = new Map(entries.map((e) => [e.name, e]));
  assert.equal(byName.get("alpha").source, "user");
  assert.equal(byName.get("beta").source, "project");
  assert.equal(byName.get("shared").config.command, "project-shared");
});

// ---------------------------------------------------------------------------
// Store rewrite (rewind) + auto-compact trigger
// ---------------------------------------------------------------------------

test("session store: rewrite replaces the transcript in place", async () => {
  const { SessionStore, loadSessionMessages } = await import("../dist/session/store.js");
  const store = new SessionStore("/proj", "test/m1");
  const m1 = { role: "user", content: [{ type: "text", text: "one" }] };
  const m2 = { role: "assistant", content: [{ type: "text", text: "two" }] };
  store.record([m1, m2]);
  // rewind to just the first message
  assert.equal(store.rewrite([m1]), 1);
  const { messages } = loadSessionMessages(store.filePath);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content[0].text, "one");
  // appending after a rewrite must not resurrect old lines
  const m3 = { role: "assistant", content: [{ type: "text", text: "three" }] };
  store.record([m1, m3]);
  const { messages: after } = loadSessionMessages(store.filePath);
  assert.equal(after.length, 2);
  assert.equal(after[1].content[0].text, "three");
});

test("auto-compact triggers near the window limit only", async () => {
  const { shouldAutoCompact } = await import("../dist/agent/compact.js");
  const model = { key: "t/m", providerId: "t", provider: {}, model: { id: "m", contextWindow: 1000 } };
  const bigText = "x".repeat(600);
  const big = Array.from({ length: 10 }, () => ({ role: "user", content: [{ type: "text", text: bigText }] }));
  assert.equal(shouldAutoCompact(big, model), true, "est. tokens ≫ 85% of 1000");
  assert.equal(shouldAutoCompact(big.slice(0, 5), model), false, "too few messages");
  const small = Array.from({ length: 10 }, () => ({ role: "user", content: [{ type: "text", text: "hi" }] }));
  assert.equal(shouldAutoCompact(small, model), false, "plenty of room");
});

// ---------------------------------------------------------------------------
// Controller commands: /rewind, /export, /status
// ---------------------------------------------------------------------------

function makeController(cwd) {
  return import("../dist/ui/session.js").then(({ SessionController }) => {
    const provider = { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: [{ id: "test-model" }] };
    const printed = [];
    const controller = new SessionController(
      {
        cwd,
        registry: { config: { providers: { mockai: provider } }, configPath: "/dev/null", providers: { mockai: provider } },
        model: { key: "mockai/test-model", providerId: "mockai", provider, model: { id: "test-model" }, headers: {} },
        policy: "ask",
      },
      { print: (l) => printed.push(l), onEvent: () => {}, askPermission: async () => true, askPlanApproval: async () => true },
    );
    return { controller, printed };
  });
}

test("controller: /rewind lists turns and rolls back, /export writes markdown, /status reports", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "wcode-ctl-"));
  const { controller, printed } = await makeController(cwd);
  controller.agent.messages = [
    { role: "user", content: [{ type: "text", text: "first question" }] },
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    { role: "user", content: [{ type: "text", text: "second question" }] },
    { role: "assistant", content: [{ type: "text", text: "second answer" }] },
  ];

  const listed = (await controller.handleLine("/rewind")) && printed.at(-1);
  assert.match(listed, /first question/);
  assert.match(listed, /second question/);

  const outcome = await controller.handleLine("/rewind 2");
  assert.equal(outcome.kind, "command");
  const rewindMsg = printed.at(-1);
  assert.match(rewindMsg, /rewound to turn 2/);
  assert.equal(controller.agent.messages.length, 2); // the first pair survives
  assert.equal(controller.agent.messages.at(-1).content[0].text, "first answer");

  const exportOutcome = await controller.handleLine("/export transcript.md");
  assert.equal(exportOutcome.kind, "command");
  assert.match(printed.at(-1), /transcript exported/);
  const md = readFileSync(join(cwd, "transcript.md"), "utf8");
  assert.match(md, /## turn 1 — user/);
  assert.match(md, /first question/);
  assert.match(md, /first answer/);

  await controller.handleLine("/status");
  const status = printed.at(-1);
  assert.match(status, /model\s+mockai\/test-model/);
  assert.match(status, /mode\s+build/);
  assert.match(status, /mcp/);
});

// ---------------------------------------------------------------------------
// E2E: real CLI against the mocks
// ---------------------------------------------------------------------------

async function startMock() {
  const httpServer = mockOpenai.server;
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;
  return {
    port,
    close: () => {
      httpServer.close();
      httpServer.closeAllConnections?.();
    },
  };
}

function writeProjectConfig(home, port, extra = {}) {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      defaultModel: "mockai/test-model",
      providers: {
        mockai: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "mock-key-123",
          models: [{ id: "test-model", contextWindow: 32000, maxTokens: 4096 }],
        },
      },
      ...extra,
    }),
  );
}

test("e2e: MCP tool call round-trips through the stdio server", async (t) => {
  const mock = await startMock();
  t.after(mock.close);
  const home = mkdtempSync(join(tmpdir(), "wcode-mcp-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-mcp-proj-"));
  writeFileSync(join(project, "WCODE.md"), "MCP-TASK: use the testsrv echo tool\n");
  writeProjectConfig(home, mock.port, {
    mcpServers: { testsrv: { command: process.execPath, args: [join(ROOT, "test", "mock-mcp.mjs")] } },
  });
  const { code, out, err } = await run(["-p", "call the echo tool", "--yolo"], { cwd: project, env: { WCODE_DIR: home } });
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /MCP_OK:echo:ping-mcp-42/);
  // the mcp tool was advertised to the model under the qualified name
  assert.ok(mockOpenai.state.requests.some((r) => (r.tools ?? []).some((tool) => tool.function?.name === "mcp__testsrv__echo")));
});

test("e2e: task tool delegates to an explore subagent and returns its report", async (t) => {
  const mock = await startMock();
  t.after(mock.close);
  const home = mkdtempSync(join(tmpdir(), "wcode-sub-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-sub-proj-"));
  writeFileSync(join(project, "hello.txt"), "hello from hello.txt\nsecond line\n");
  writeFileSync(join(project, "WCODE.md"), "TASK-SUBAGENT: delegate to explore\n");
  writeProjectConfig(home, mock.port);
  const { code, out, err } = await run(["-p", "delegate this", "--yolo"], { cwd: project, env: { WCODE_DIR: home } });
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /PARENT_GOT:SUB_REPORT:hello from hello\.txt/);
  // the subagent ran its own loop: a request with the subagent system prompt
  assert.ok(mockOpenai.state.requests.some((r) => (r.messages[0]?.content ?? "").includes("wcode subagent dispatched")));
});

test("task tool: subagent activity streams to the parent, stalled streams recover", async (t) => {
  const mock = await startMock();
  t.after(mock.close);
  const home = mkdtempSync(join(tmpdir(), "wcode-prog-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-prog-proj-"));
  writeFileSync(join(project, "hello.txt"), "hello from hello.txt\nsecond line\n");
  writeProjectConfig(home, mock.port);
  const { Agent: _Agent } = await import("../dist/agent/agent.js");
  const { createTaskTool } = await import("../dist/tools/task.js");
  const { createTools } = await import("../dist/tools/index.js");

  const model = {
    key: "mockai/test-model",
    providerId: "mockai",
    provider: {
      api: "openai-completions",
      name: "mockai",
      baseUrl: `http://127.0.0.1:${mock.port}/v1`,
      apiKey: "mock-key-123",
      models: [{ id: "test-model", contextWindow: 32000, maxTokens: 4096 }],
    },
    model: { id: "test-model", contextWindow: 32000, maxTokens: 4096 },
    apiKey: "mock-key-123",
    headers: {},
  };
  const makeTool = () =>
    createTaskTool({
      cwd: project,
      model: () => model,
      effectivePolicy: () => "ask",
      requestPermission: async () => true,
      baseTools: () => createTools({ supportsImages: false, policy: "ask" }),
    });
  const makeCtx = (updates) => ({
    cwd: project,
    readFileState: new Map(),
    requestPermission: async () => true,
    onUpdate: (line) => updates.push(line),
  });

  // Happy path: the subagent's tool activity reaches ctx.onUpdate as
  // tool_update lines — parallel tasks are no longer silent while working.
  const updates = [];
  const out = await makeTool().execute(
    { description: "find hello file", prompt: "Read hello.txt and report its first line.", subagent_type: "explore" },
    makeCtx(updates),
  );
  assert.match(out.content[0].text, /SUB_REPORT:hello from hello\.txt/);
  assert.ok(
    updates.some((l) => l === "task(explore): find hello file · read hello.txt"),
    `expected a read progress line, got: ${updates.join(" | ")}`,
  );

  // Stalled subagent stream: the heartbeat marks the quiet gap, the stream
  // idle guard ends the hang, and the tool fails loudly instead of freezing
  // (partial streamed text must not pass as the "report").
  const stalled = [];
  await assert.rejects(
    makeTool().execute(
      { description: "stall it", prompt: "STALL_SUB: read hello.txt and report.", subagent_type: "explore" },
      makeCtx(stalled),
    ),
    /failed before reporting.*stream idle/,
  );
  assert.ok(
    stalled.some((l) => l.includes("quiet (thinking")),
    `expected a heartbeat line, got: ${stalled.join(" | ")}`,
  );
  assert.ok(
    stalled.some((l) => l.includes("error: stream idle")),
    `expected the idle-guard error, got: ${stalled.join(" | ")}`,
  );
});

test("e2e: a stalled provider stream errors out instead of hanging forever", async (t) => {
  const mock = await startMock();
  t.after(mock.close);
  const home = mkdtempSync(join(tmpdir(), "wcode-stall-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-stall-proj-"));
  writeFileSync(join(project, "WCODE.md"), "STALL-TASK: hold the stream open\n");
  writeProjectConfig(home, mock.port);
  const child = spawn(process.execPath, [BIN, "-p", "go", "--yolo"], {
    cwd: project,
    env: { ...process.env, WCODE_DIR: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const result = await new Promise((resolve) => {
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ hung: true, code: null });
    }, 15_000);
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ hung: false, code });
    });
  });
  assert.equal(result.hung, false, "CLI hung on a stalled provider stream instead of erroring out");
  assert.equal(result.code, 1, `stderr: ${err}`);
  assert.match(err, /stream idle/);
});

test("e2e: deny rule blocks bash even under --yolo", async (t) => {
  const mock = await startMock();
  t.after(mock.close);
  const home = mkdtempSync(join(tmpdir(), "wcode-deny-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-deny-proj-"));
  writeFileSync(join(project, "WCODE.md"), "DENY-TASK: try the blocked command\n");
  mkdirSync(join(project, ".wcode"), { recursive: true });
  writeFileSync(join(project, ".wcode", "settings.json"), '{ "permissions": { "deny": ["bash(echo blocked-*)"] } }');
  writeProjectConfig(home, mock.port);
  const { code, out, err } = await run(["-p", "run it", "--yolo"], { cwd: project, env: { WCODE_DIR: home } });
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /DENY_ENFORCED/);
});

test("e2e: custom command expands in print mode", async (t) => {
  const mock = await startMock();
  t.after(mock.close);
  const home = mkdtempSync(join(tmpdir(), "wcode-cmd-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-cmd-proj-"));
  mkdirSync(join(project, ".wcode", "commands"), { recursive: true });
  writeFileSync(join(project, ".wcode", "commands", "greet.md"), "---\ndescription: greet someone\n---\nSay GREET_SENTINEL=$ARGUMENTS out loud.");
  writeProjectConfig(home, mock.port);
  const { code, out, err } = await run(["-p", "/greet world"], { cwd: project, env: { WCODE_DIR: home } });
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /GREET_RECEIVED:world/);
});

test("e2e: --output-format json emits a JSON envelope; --append-system-prompt lands in the system", async (t) => {
  const mock = await startMock();
  t.after(mock.close);
  const home = mkdtempSync(join(tmpdir(), "wcode-json-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-json-proj-"));
  writeFileSync(join(project, "hello.txt"), "hello from hello.txt\n");
  writeProjectConfig(home, mock.port);
  const { code, out, err } = await run(
    ["-p", "read hello.txt", "--output-format", "json", "--append-system-prompt", "APPEND_SENTINEL-extra-rules"],
    { cwd: project, env: { WCODE_DIR: home } },
  );
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  const envelope = JSON.parse(out);
  assert.equal(envelope.model, "mockai/test-model");
  assert.equal(envelope.is_error, false);
  assert.match(envelope.result, /FILE_SAYS:hello from hello\.txt/);
  assert.equal(typeof envelope.inputTokens, "number");
  const last = mockOpenai.state.requests.at(-1);
  assert.match(last.messages[0].content, /APPEND_SENTINEL-extra-rules/);
});
