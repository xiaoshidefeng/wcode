// Mock OpenAI-compatible server for end-to-end tests.
// Scripted behavior:
//   turn 1 (no tool messages yet): stream some text, then a `read` tool_call
//   turn 2 (tool result present):  if asked to write, emit a `write` tool_call;
//                                  otherwise answer with FILE_SAYS:<content>
//   PLAN-TASK in system:           turn 1 emits an `exit_plan` tool_call; turn 2
//                                  answers PLAN_APPROVED:IMPLEMENTING when the plan
//                                  was approved, PLAN_FEEDBACK:keep-planning otherwise
//   TODO-TASK in system:           turn 1 emits a `todo_write` tool_call; turn 2
//                                  answers TODO_OK:list-tracked
//   MCP-TASK in system:            turn 1 emits a `mcp__testsrv__echo` tool_call;
//                                  turn 2 answers MCP_OK:<echoed text>
//   TASK-SUBAGENT in system:       turn 1 emits a `task` tool_call (explore);
//                                  turn 2 answers PARENT_GOT:<subagent report>
//   subagent context ("wcode subagent dispatched" in system):
//                                  turn 1 emits a `read` call; turn 2 answers
//                                  SUB_REPORT:<file content>
//   DENY-TASK in system:           turn 1 emits a `bash` call; turn 2 answers
//                                  DENY_ENFORCED when the call was rule-blocked
//   STALL-TASK in system:          main stream goes silent after one chunk
//                                  (client must recover via idle timeout)
//   STALL_SUB in a task prompt:    the subagent stream goes silent likewise
//   GREET_SENTINEL in user msg:    answers GREET_RECEIVED:<arg> (custom commands)
import http from "node:http";

const state = { requests: [] };

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

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      handle(req, res, body);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    }
  });
});

function handle(req, res, body) {
  {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== "Bearer mock-key-123") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad api key" } }));
      return;
    }
    const parsed = JSON.parse(body);
    state.requests.push(parsed);

    // sanity checks on wcode's request shape
    if (parsed.stream !== true) throw new Error("expected stream:true");
    if (parsed.messages[0].role !== "system") throw new Error("expected system first");
    if (parsed.tools !== undefined && !Array.isArray(parsed.tools)) throw new Error("bad tools field");

    // /compact-style summarization request: no tools offered.
    if (!parsed.tools || parsed.tools.length === 0) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, [
        textChunk("chatcmpl-sum", { role: "assistant", content: "SUMMARY: user asked about files; agent read them." }),
        textChunk("chatcmpl-sum", {}, "stop"),
      ]);
      return;
    }

    const id = "chatcmpl-test";
    const systemText = parsed.messages.find((m) => m.role === "system")?.content ?? "";
    const isSubagent = systemText.includes("wcode subagent dispatched");

    const pasteHit = parsed.messages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("PASTE_SENTINEL"),
    );
    if (pasteHit) {
      const msg = parsed.messages.find((m) => m.role === "user" && m.content.includes("PASTE_SENTINEL")).content;
      const value = msg.match(/PASTE_SENTINEL=(\S+)/)?.[1] ?? "none";
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, [textChunk(id, { role: "assistant", content: `PASTE_RECEIVED:${value}` }), textChunk(id, {}, "stop")]);
      return;
    }

    // Custom-command e2e: the expanded template reached the model verbatim.
    const greetArg = parsed.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("GREET_SENTINEL"),
    )?.content?.match(/GREET_SENTINEL=(\S+)/)?.[1];
    if (greetArg !== undefined) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, [textChunk(id, { role: "assistant", content: `GREET_RECEIVED:${greetArg}` }), textChunk(id, {}, "stop")]);
      return;
    }

    // Subagent loop: read the file, then report it back as the final message.
    if (isSubagent) {
      // STALL_SUB in the task prompt: hold the stream open forever after one
      // chunk — the client must recover via its stream idle timeout.
      const stallSub = JSON.stringify(parsed.messages.find((m) => m.role === "user")?.content ?? "").includes("STALL_SUB");
      if (stallSub) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(textChunk(id, { role: "assistant", content: "starting…" }))}\n\n`);
        return; // deliberately never write again, never end
      }
      const hasResult = parsed.messages.some((m) => m.role === "tool");
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!hasResult) {
        sse(res, [
          textChunk(id, { role: "assistant", content: "Reading the file." }),
          textChunk(id, {
            tool_calls: [{ index: 0, id: "call_sub_read", type: "function", function: { name: "read", arguments: '{"path": "hello.txt"}' } }],
          }),
          textChunk(id, {}, "tool_calls"),
        ]);
      } else {
        const content = parsed.messages.find((m) => m.role === "tool")?.content ?? "";
        const found = content.match(/hello from hello\.txt/)?.[0] ?? "not found";
        sse(res, [textChunk(id, { role: "assistant", content: `SUB_REPORT:${found}` }), textChunk(id, {}, "stop")]);
      }
      return;
    }

    const hasToolResult = parsed.messages.some((m) => m.role === "tool");
    const wantsWrite = systemText.includes("WRITE-TASK");
    const wantsPlan = systemText.includes("PLAN-TASK");
    const wantsTodo = systemText.includes("TODO-TASK");
    const wantsMcp = systemText.includes("MCP-TASK");
    const wantsSub = systemText.includes("TASK-SUBAGENT");
    const wantsDeny = systemText.includes("DENY-TASK");
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // STALL-TASK in system: hold the main stream open forever after one
    // chunk — the CLI must abort it via the idle timeout, not hang.
    if (systemText.includes("STALL-TASK")) {
      res.write(`data: ${JSON.stringify(textChunk(id, { role: "assistant", content: "starting…" }))}\n\n`);
      return; // deliberately never write again, never end
    }

    if (!hasToolResult) {
      if (wantsMcp) {
        const args = JSON.stringify({ text: "ping-mcp-42" });
        sse(res, [
          textChunk(id, { role: "assistant", content: "Calling the MCP tool." }),
          textChunk(id, {
            tool_calls: [{ index: 0, id: "call_mcp_1", type: "function", function: { name: "mcp__testsrv__echo", arguments: args } }],
          }),
          textChunk(id, {}, "tool_calls"),
        ]);
        return;
      }
      if (wantsSub) {
        const args = JSON.stringify({
          description: "find hello file",
          prompt: "Read hello.txt in the working directory and report its first line.",
          subagent_type: "explore",
        });
        const cut = Math.floor(args.length / 2);
        sse(res, [
          textChunk(id, { role: "assistant", content: "Delegating to a subagent." }),
          textChunk(id, {
            tool_calls: [{ index: 0, id: "call_task_1", type: "function", function: { name: "task", arguments: args.slice(0, cut) } }],
          }),
          textChunk(id, { tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] }),
          textChunk(id, {}, "tool_calls"),
        ]);
        return;
      }
      if (wantsDeny) {
        sse(res, [
          textChunk(id, { role: "assistant", content: "Running a command." }),
          textChunk(id, {
            tool_calls: [{ index: 0, id: "call_bash_1", type: "function", function: { name: "bash", arguments: '{"command": "echo blocked-command-xyz"}' } }],
          }),
          textChunk(id, {}, "tool_calls"),
        ]);
        return;
      }
      if (wantsTodo) {
        // Task list: emit a todo_write call (args split across chunks).
        const args = JSON.stringify({
          todos: [
            { content: "step one", status: "completed" },
            { content: "step two", status: "in_progress" },
            { content: "step three", status: "pending" },
          ],
        });
        const cut = Math.floor(args.length / 2);
        sse(res, [
          textChunk(id, { role: "assistant", content: "Tracking the work." }),
          textChunk(id, {
            tool_calls: [{ index: 0, id: "call_todo_1", type: "function", function: { name: "todo_write", arguments: args.slice(0, cut) } }],
          }),
          textChunk(id, {
            tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }],
          }),
          textChunk(id, {}, "tool_calls"),
        ]);
        return;
      }
      if (wantsPlan) {
        // Plan mode: submit a plan via exit_plan (args split across chunks).
        const args = JSON.stringify({ plan: "PLAN_BODY\n1. Do the thing\n2. Verify it\n" });
        const cut = Math.floor(args.length / 2);
        sse(res, [
          textChunk(id, { role: "assistant", content: "Researching first." }),
          textChunk(id, {
            tool_calls: [{ index: 0, id: "call_plan_1", type: "function", function: { name: "exit_plan", arguments: args.slice(0, cut) } }],
          }),
          textChunk(id, {
            tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }],
          }),
          textChunk(id, {}, "tool_calls"),
        ]);
        return;
      }
      if (wantsWrite) {
        // Emit a write tool call with arguments split across chunks.
        const args = JSON.stringify({ path: "agent-output.txt", content: "written by wcode agent\n" });
        const cut = Math.floor(args.length / 2);
        sse(res, [
          textChunk(id, { role: "assistant", content: "I'll create the file." }),
          textChunk(id, {
            tool_calls: [{ index: 0, id: "call_write_1", type: "function", function: { name: "write", arguments: args.slice(0, cut) } }],
          }),
          textChunk(id, {
            tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }],
          }),
          textChunk(id, {}, "tool_calls"),
          { id, object: "chat.completion.chunk", model: "test-model", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
        ]);
      } else {
        sse(res, [
          textChunk(id, { role: "assistant", content: "Let me read the file." }),
          textChunk(id, {
            tool_calls: [{ index: 0, id: "call_read_1", type: "function", function: { name: "read", arguments: '{"path":' } }],
          }),
          textChunk(id, {
            tool_calls: [{ index: 0, function: { arguments: ' "hello.txt"}' } }],
          }),
          textChunk(id, {}, "tool_calls"),
        ]);
      }
      return;
    }

    if (wantsMcp) {
      const toolMsg = parsed.messages.find((m) => m.role === "tool");
      const echoed = (toolMsg?.content ?? "").match(/echo:ping-mcp-42/)?.[0];
      sse(res, [textChunk(id, { role: "assistant", content: echoed ? `MCP_OK:${echoed}` : `MCP_FAIL:${(toolMsg?.content ?? "").slice(0, 120)}` }), textChunk(id, {}, "stop")]);
      return;
    }

    if (wantsSub) {
      const toolMsg = parsed.messages.find((m) => m.role === "tool");
      const report = (toolMsg?.content ?? "").match(/SUB_REPORT:hello from hello\.txt/)?.[0] ?? "no-report";
      sse(res, [textChunk(id, { role: "assistant", content: `PARENT_GOT:${report}` }), textChunk(id, {}, "stop")]);
      return;
    }

    if (wantsDeny) {
      const toolMsg = parsed.messages.find((m) => m.role === "tool");
      const denied = (toolMsg?.content ?? "").includes("denied by a permission rule");
      sse(res, [textChunk(id, { role: "assistant", content: denied ? "DENY_ENFORCED" : "DENY_FAILED" }), textChunk(id, {}, "stop")]);
      return;
    }

    if (wantsTodo) {
      const toolMsg = parsed.messages.find((m) => m.role === "tool");
      const tracked = (toolMsg?.content ?? "").includes("Todo list updated");
      sse(res, [textChunk(id, { role: "assistant", content: tracked ? "TODO_OK:list-tracked" : "TODO_FAIL" }), textChunk(id, {}, "stop")]);
      return;
    }

    if (wantsPlan) {
      const toolMsg = parsed.messages.find((m) => m.role === "tool");
      const approved = (toolMsg?.content ?? "").includes("PLAN APPROVED");
      sse(res, [
        textChunk(id, { role: "assistant", content: approved ? "PLAN_APPROVED:IMPLEMENTING" : "PLAN_FEEDBACK:keep-planning" }),
        textChunk(id, {}, "stop"),
      ]);
      return;
    }

    if (wantsWrite) {
      sse(res, [textChunk(id, { role: "assistant", content: "WRITE_DONE" }), textChunk(id, {}, "stop")]);
      return;
    }
    const toolMsg = parsed.messages.find((m) => m.role === "tool");
    const content = toolMsg?.content ?? "";
    const match = content.match(/hello from hello\.txt/g);
    sse(res, [
      textChunk(id, { role: "assistant", content: `FILE_SAYS:${match ? match[0] : "not found"}` }),
      textChunk(id, {}, "stop"),
      { id, object: "chat.completion.chunk", model: "test-model", choices: [], usage: { prompt_tokens: 200, completion_tokens: 10 } },
    ]);
  }
}

export default { server, state };
