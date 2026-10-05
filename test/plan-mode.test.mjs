// Plan mode tests: tool gating (policy "plan"), the exit_plan tool, plan-mode
// toolset/prompt assembly, SessionController mode wiring, and an end-to-end
// REPL run where the mock model submits a plan and the user approves/rejects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import mockOpenai from "./mock-openai.mjs";
import { runTool, planModeTools, createTools } from "../dist/tools/index.js";
import { createExitPlanTool, PLAN_APPROVED_TEXT, PLAN_REJECTED_TEXT } from "../dist/tools/plan.js";
import { buildSystemPrompt } from "../dist/system-prompt.js";
import { SessionController } from "../dist/ui/session.js";
import { parseKeypress } from "../dist/ui/keys.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "wcode.js");

const okCtx = (dir) => ({ cwd: dir, readFileState: new Map(), requestPermission: async () => true });

test("plan policy: mutating tools blocked with a reason, read-only allowed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcode-plan-ut-"));
  const sentinel = join(dir, "sentinel.txt");
  const tools = createTools({ supportsImages: false, policy: "ask" });
  const ctx = okCtx(dir);
  const asked = [];
  ctx.requestPermission = async (req) => {
    asked.push(req.tool);
    return true;
  };

  for (const name of ["write", "edit", "bash"]) {
    const args = name === "write" ? { path: sentinel, content: "nope" } : name === "edit" ? { path: sentinel, old_string: "a", new_string: "b" } : { command: `echo nope > ${sentinel}` };
    const r = await runTool(tools, name, args, ctx, "plan");
    assert.equal(r.isError, true, `${name} must be blocked in plan mode`);
    assert.match(r.output.content[0].text, /plan mode/);
    assert.match(r.output.display, /blocked/);
  }
  assert.deepEqual(asked, [], "plan-mode blocks must not reach the permission prompt");
  assert.ok(!existsSync(sentinel), "blocked bash/write must not touch the filesystem");

  // read-only tools keep working without a permission ask
  writeFileSync(join(dir, "readable.txt"), "hello\n");
  const r = await runTool(tools, "read", { path: join(dir, "readable.txt") }, ctx, "plan");
  assert.equal(r.isError, false);
  assert.match(r.output.content[0].text, /hello/);
});

test("plan policy beats yolo: even allow-all permission cannot execute a mutating tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wcode-plan-yolo-"));
  const tools = createTools({ supportsImages: false, policy: "yolo" });
  const r = await runTool(tools, "bash", { command: "echo should-not-run" }, okCtx(dir), "plan");
  assert.equal(r.isError, true);
  assert.match(r.output.content[0].text, /plan mode/);
});

test("planModeTools: read-only set + exit_plan only", () => {
  const tools = createTools({ supportsImages: false, policy: "ask" });
  const plan = planModeTools(tools, createExitPlanTool(async () => true));
  assert.deepEqual(plan.map((t) => t.name).sort(), ["exit_plan", "glob", "grep", "ls", "read"]);
});

test("exit_plan tool: asks with the plan, reports approval/rejection", async () => {
  let received = null;
  const approve = createExitPlanTool(async (plan) => {
    received = plan;
    return true;
  });
  assert.equal(approve.readOnly, true);
  const out = await approve.execute({ plan: "# my plan\nstep 1" }, okCtx("/tmp"));
  assert.equal(received, "# my plan\nstep 1");
  assert.match(out.content[0].text, /PLAN APPROVED/);
  assert.equal(out.content[0].text, PLAN_APPROVED_TEXT);

  const reject = createExitPlanTool(async () => false);
  const out2 = await reject.execute({ plan: "revise me" }, okCtx("/tmp"));
  assert.equal(out2.content[0].text, PLAN_REJECTED_TEXT);
  assert.match(out2.content[0].text, /keep planning/);

  await assert.rejects(() => reject.execute({ plan: "  " }, okCtx("/tmp")), /plan must not be empty/);
});

test("system prompt: plan section only in plan mode", () => {
  const base = { cwd: "/x", toolNames: ["read"] };
  assert.match(buildSystemPrompt({ ...base, mode: "plan" }), /# Plan mode \(active\)/);
  assert.match(buildSystemPrompt({ ...base, mode: "plan" }), /exit_plan/);
  assert.doesNotMatch(buildSystemPrompt({ ...base, mode: "build" }), /Plan mode/);
  assert.doesNotMatch(buildSystemPrompt(base), /Plan mode/);
});

function makeController(cwd, hooks, mode) {
  const provider = { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: [{ id: "test-model" }] };
  return new SessionController(
    {
      cwd,
      registry: { config: { providers: { mockai: provider } }, configPath: "/dev/null", providers: { mockai: provider } },
      model: { key: "mockai/test-model", providerId: "mockai", provider, model: { id: "test-model" }, headers: {} },
      policy: "ask",
      mode,
    },
    hooks,
  );
}

test("SessionController: mode toggles swap toolset, policy gate and system prompt", async () => {
  const home = mkdtempSync(join(tmpdir(), "wcode-plan-ctl-"));
  process.env.WCODE_DIR = home;
  const printed = [];
  try {
    const controller = makeController(home, {
      print: (l) => printed.push(l),
      onEvent: () => {},
      askPermission: async () => true,
      askPlanApproval: async () => true,
    });
    assert.equal(controller.mode, "build");
    const buildToolNames = controller.agent.options.tools.map((t) => t.name);
    assert.ok(buildToolNames.includes("write") && buildToolNames.includes("bash"));
    assert.ok(!buildToolNames.includes("exit_plan"));
    assert.equal(controller.agent.options.policy, "ask");

    assert.equal(controller.toggleMode(), "edit");
    assert.equal(controller.agent.options.policy, "edit", "edit mode auto-approves file edits");
    assert.doesNotMatch(controller.agent.options.system, /Plan mode/);

    assert.equal(controller.toggleMode(), "plan");
    const planToolNames = controller.agent.options.tools.map((t) => t.name);
    assert.deepEqual(planToolNames.filter((n) => n !== "exit_plan" && n !== "todo_write").every((n) => ["read", "grep", "glob", "ls"].includes(n)), true);
    assert.ok(planToolNames.includes("exit_plan"));
    assert.ok(planToolNames.includes("todo_write"), "task list stays available in plan mode");
    assert.equal(controller.agent.options.policy, "plan");
    assert.match(controller.agent.options.system, /# Plan mode \(active\)/);

    // full cycle returns to build mode wholesale
    assert.equal(controller.toggleMode(), "build");
    assert.equal(controller.agent.options.policy, "ask");
    assert.doesNotMatch(controller.agent.options.system, /Plan mode/);

    // /plan slash command with explicit on/off args
    await controller.handleLine("/plan on");
    assert.equal(controller.mode, "plan");
    await controller.handleLine("/plan off");
    assert.equal(controller.mode, "build");
    assert.ok(printed.some((l) => /plan mode on/.test(l)));
  } finally {
    if (process.env.WCODE_DIR === home) delete process.env.WCODE_DIR;
  }
});

test("SessionController: exit_plan persists the plan and approval switches to build", async () => {
  const home = mkdtempSync(join(tmpdir(), "wcode-plan-approve-"));
  process.env.WCODE_DIR = home;
  try {
    const approvals = [];
    const controller = makeController(
      home,
      {
        print: () => {},
        onEvent: () => {},
        askPermission: async () => true,
        askPlanApproval: async (req) => {
          approvals.push(req);
          return true;
        },
      },
      "plan",
    );
    const exitPlan = controller.agent.options.tools.find((t) => t.name === "exit_plan");
    const out = await exitPlan.execute({ plan: "step one" }, okCtx(home));
    assert.match(out.content[0].text, /PLAN APPROVED/);
    assert.equal(approvals.length, 1);
    assert.match(approvals[0].planFile, /^\.wcode\/plans\/.+\.md$/);
    const saved = readFileSync(join(home, approvals[0].planFile), "utf8");
    assert.match(saved, /step one/);
    assert.equal(controller.mode, "build", "approval must leave plan mode");
  } finally {
    if (process.env.WCODE_DIR === home) delete process.env.WCODE_DIR;
  }
});

test("SessionController: rejected plan keeps plan mode", async () => {
  const home = mkdtempSync(join(tmpdir(), "wcode-plan-reject-"));
  process.env.WCODE_DIR = home;
  try {
    const controller = makeController(
      home,
      { print: () => {}, onEvent: () => {}, askPermission: async () => true, askPlanApproval: async () => false },
      "plan",
    );
    const exitPlan = controller.agent.options.tools.find((t) => t.name === "exit_plan");
    const out = await exitPlan.execute({ plan: "draft" }, okCtx(home));
    assert.match(out.content[0].text, /keep planning/);
    assert.equal(controller.mode, "plan");
    assert.equal(controller.agent.options.policy, "plan");
  } finally {
    if (process.env.WCODE_DIR === home) delete process.env.WCODE_DIR;
  }
});

test("shift+tab parses as tab with shift modifier (mode toggle keypath)", () => {
  const key = parseKeypress("\x1b[Z");
  assert.ok(key && key !== "incomplete");
  assert.equal(key.name, "tab");
  assert.equal(key.shift, true);
});

// ---------------------------------------------------------------------------
// E2E: real CLI, mock provider, full plan flow through the plain REPL.
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

test("e2e: plan mode — exit_plan approval flips to build and implements", async (t) => {
  const httpServer = await startServer(t);
  const port = httpServer.address().port;
  const home = mkdtempSync(join(tmpdir(), "wcode-plan-home-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-plan-proj-"));
  writeFileSync(join(project, "WCODE.md"), "PLAN-TASK: research and plan the change\n");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      providers: {
        mockai: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "mock-key-123", models: [{ id: "test-model" }] },
      },
    }),
  );
  const base = mockOpenai.state.requests.length;
  const { done } = repl(["--plan"], "make a plan\ny\n/exit\n", { home, project });
  const { code, out, err } = await done;
  assert.notEqual(code, 137, "not watchdog-killed");
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /PLAN_APPROVED:IMPLEMENTING/);

  // the plan was persisted under .wcode/plans/
  const plansDir = join(project, ".wcode", "plans");
  assert.ok(existsSync(plansDir));
  const files = readdirSync(plansDir);
  assert.equal(files.length, 1);
  assert.match(readFileSync(join(plansDir, files[0]), "utf8"), /Do the thing/);

  // request 1: plan toolset (no write/edit/bash, system carries the plan section)
  const req1 = mockOpenai.state.requests[base];
  const names1 = req1.tools.map((tool) => tool.function?.name ?? tool.name);
  assert.ok(names1.includes("exit_plan"), `tools: ${names1}`);
  assert.ok(!names1.includes("write") && !names1.includes("edit") && !names1.includes("bash"));
  assert.match(req1.messages[0].content, /Plan mode \(active\)/);
  // request 2 (after approval): build toolset restored, plan section gone
  const req2 = mockOpenai.state.requests[base + 1];
  const names2 = req2.tools.map((tool) => tool.function?.name ?? tool.name);
  assert.ok(names2.includes("write") && names2.includes("bash"), `tools: ${names2}`);
  assert.ok(!names2.includes("exit_plan"));
  assert.doesNotMatch(req2.messages[0].content, /Plan mode \(active\)/);
});

test("e2e: plan mode — rejected plan stays read-only", async (t) => {
  const httpServer = await startServer(t);
  const port = httpServer.address().port;
  const home = mkdtempSync(join(tmpdir(), "wcode-plan-home2-"));
  const project = mkdtempSync(join(tmpdir(), "wcode-plan-proj2-"));
  writeFileSync(join(project, "WCODE.md"), "PLAN-TASK: research and plan the change\n");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      providers: {
        mockai: { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "mock-key-123", models: [{ id: "test-model" }] },
      },
    }),
  );
  const base = mockOpenai.state.requests.length;
  const { done } = repl(["--plan"], "make a plan\nn\n/exit\n", { home, project });
  const { code, out, err } = await done;
  assert.equal(code, 0, `stderr: ${err}\nstdout: ${out}`);
  assert.match(out, /PLAN_FEEDBACK:keep-planning/);

  const req2 = mockOpenai.state.requests[base + 1];
  const names2 = req2.tools.map((tool) => tool.function?.name ?? tool.name);
  assert.ok(!names2.includes("write") && !names2.includes("bash"), `still read-only: ${names2}`);
  assert.match(req2.messages[0].content, /Plan mode \(active\)/);
});
