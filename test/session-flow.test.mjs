// Session flow tests: "always allow" permission rules (subject attachment,
// gate.addAllow, settings persistence) and the ! / # input prefixes (shell
// passthrough with context injection, WCODE.md memory notes).
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
const HOME = mkdtempSync(join(tmpdir(), "wcode-flow-home-"));
process.env.WCODE_DIR = HOME;

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

/** Interactive plain-mode run: pipe lines, collect output. */
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

function writeConfig(home, port) {
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
    }),
  );
}

// ---------------------------------------------------------------------------

test("PermissionGate.addAllow: runtime rules match, dedupe, deny still wins", async () => {
  const { PermissionGate } = await import("../dist/permissions.js");
  const gate = new PermissionGate();
  assert.equal(gate.isEmpty, true);
  assert.equal(gate.decide("bash", "npm test"), "ask");
  gate.addAllow("bash(npm *)");
  assert.equal(gate.isEmpty, false);
  assert.equal(gate.decide("bash", "npm run build"), "allow");
  assert.equal(gate.decide("bash", "npm malicious"), "allow");
  assert.equal(gate.decide("bash", "ls"), "ask");
  gate.addAllow("bash(npm *)"); // duplicate is a no-op
  assert.equal(gate.decide("bash", "npm test"), "allow");
  gate.addAllow("not a (valid rule");
  assert.equal(gate.decide("not", undefined), "ask");
  // deny rules loaded at construction still take precedence
  const gated = new PermissionGate([], ["bash(rm -rf *)"]);
  gated.addAllow("bash(*)");
  assert.equal(gated.decide("bash", "rm -rf /"), "deny");
});

test("runTool attaches the permission subject to every ask (bash → command, write → path)", async () => {
  const { createTools, runTool } = await import("../dist/tools/index.js");
  const dir = mkdtempSync(join(tmpdir(), "wcode-subj-"));
  const tools = createTools({ supportsImages: false, policy: "ask" });
  const reqs = [];
  const ctx = {
    cwd: dir,
    readFileState: new Map(),
    requestPermission: async (req) => {
      reqs.push(req);
      return true;
    },
  };
  await runTool(tools, "bash", { command: "echo subject-check" }, ctx, "ask");
  await runTool(tools, "write", { path: join(dir, "f.txt"), content: "x" }, ctx, "ask");
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].subject, "echo subject-check");
  assert.equal(reqs[1].subject, "f.txt"); // inside cwd → relative
});

test("SessionController: ! runs shell and joins context, # writes memory, /help lists shortcuts", async () => {
  const home = mkdtempSync(join(tmpdir(), "wcode-flow-ctrl-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-flow-ctrl-proj-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ defaultModel: "mockai/test-model", providers: { mockai: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: [{ id: "test-model", contextWindow: 32000 }] } } }));
  const savedEnv = process.env.WCODE_DIR;
  process.env.WCODE_DIR = home; // must precede the dist/config.js import below
  try {
    const { loadRegistry, resolveModel } = await import("../dist/config.js");
    const { SessionController } = await import("../dist/ui/session.js");
    const registry = loadRegistry();
    const model = resolveModel(registry);
    const printed = [];
    const controller = new SessionController(
      { cwd: project, registry, model, policy: "ask" },
      { print: (l) => printed.push(l), onEvent: () => {}, askPermission: async () => "yes", askPlanApproval: async () => true },
    );

    const bang = await controller.handleLine("!echo unit-bang-sentinel");
    assert.equal(bang.kind, "command");
    assert.match(printed.join("\n"), /unit-bang-sentinel/);
    const last = controller.agent.messages.at(-1);
    assert.equal(last.role, "user");
    assert.match(last.content[0].text, /<bash-input>echo unit-bang-sentinel<\/bash-input>/);
    assert.match(last.content[0].text, /<bash-status>exit code 0<\/bash-status>/);
    assert.match(last.content[0].text, /<bash-output>[^]*unit-bang-sentinel[^]*<\/bash-output>/);

    const mem = await controller.handleLine("#unit-memory-sentinel");
    assert.equal(mem.kind, "command");
    assert.match(readFileSync(join(project, "WCODE.md"), "utf8"), /- unit-memory-sentinel/);

    printed.length = 0;
    await controller.handleLine("/help");
    assert.match(printed.join("\n"), /shortcuts:/);
    assert.match(printed.join("\n"), /ctrl\+j/);
    assert.match(printed.join("\n"), /! cmd/);

    // bare answer words never reach the model as prompts
    assert.equal((await controller.handleLine("a")).kind, "skip");
    assert.equal((await controller.handleLine("always")).kind, "skip");
  } finally {
    process.env.WCODE_DIR = savedEnv;
  }
});

test("e2e: ! shell passthrough, # memory note and /help shortcuts in the REPL", async () => {
  const home = mkdtempSync(join(tmpdir(), "wcode-flow-e2e-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-flow-e2e-proj-"));
  writeConfig(home, 1); // never dialed — no model calls in this scenario
  const { done } = repl([], "!echo e2e-bang-sentinel\n#e2e-memory-sentinel\n/help\n/exit\n", { home, project });
  const { code, out, err } = await done;
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /e2e-bang-sentinel/);
  assert.match(out, /memory: added to/);
  assert.match(readFileSync(join(project, "WCODE.md"), "utf8"), /- e2e-memory-sentinel/);
  assert.match(out, /shortcuts:/);
});

test("e2e: permission 'always allow' saves a rule and future sessions skip the ask", async (t) => {
  const httpServer = mockOpenai.server;
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  t.after(() => {
    httpServer.close();
    httpServer.closeAllConnections?.();
  });
  const port = httpServer.address().port;
  const home = mkdtempSync(join(tmpdir(), "wcode-flow-allow-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-flow-allow-proj-"));
  writeFileSync(join(project, "WCODE.md"), "DENY-TASK: run the command\n");
  writeConfig(home, port);

  // pass 1: the model calls bash; the user answers "a" (always allow)
  const { done } = repl([], "run it\na\n/exit\n", { home, project });
  const first = await done;
  assert.equal(first.code, 0, `stderr: ${first.err}\nstdout: ${first.out}`);
  assert.match(first.out, /rule saved to .*\.wcode\/settings\.json: bash\(echo \*\)/);
  const settings = JSON.parse(readFileSync(join(project, ".wcode", "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions.allow, ["bash(echo *)"]);

  // pass 2: fresh session, no user attached (print mode denies asks) — the
  // saved rule lets the same bash call through without a prompt
  const second = await run(["-p", "run it"], { cwd: project, env: { WCODE_DIR: home } });
  assert.equal(second.code, 0, `stderr: ${second.err}\nstdout: ${second.out}`);
  assert.match(second.out, /DENY_FAILED/); // command executed (mock saw a real tool result)
});

test("e2e: CLI prompt arg starts working immediately in the plain session", async (t) => {
  const httpServer = mockOpenai.server;
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  t.after(() => {
    httpServer.close();
    httpServer.closeAllConnections?.();
  });
  const port = httpServer.address().port;
  const home = mkdtempSync(join(tmpdir(), "wcode-flow-init-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-flow-init-proj-"));
  writeFileSync(join(project, "WCODE.md"), "DENY-TASK: run the command\n");
  writeConfig(home, port);
  // no stdin lines at all — the positional prompt must run on its own, then
  // EOF ends the session
  const child = spawn(process.execPath, [BIN, "run it", "--yolo"], {
    cwd: project,
    env: { ...process.env, WCODE_DIR: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const code = await new Promise((resolve) => {
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("close", (c) => {
      clearTimeout(watchdog);
      resolve(c);
    });
  });
  assert.equal(code, 0, `stdout: ${out}`);
  assert.match(out, /DENY_FAILED/);
});
