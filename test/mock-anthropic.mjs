// Mock Anthropic Messages server for end-to-end tests.
// Scripted: turn 1 emits a read tool_use with input JSON in two deltas;
// turn 2 answers with ANTHROPIC_OK + a snippet of the tool result.
import http from "node:http";

const state = { requests: [] };

function sseEvents(res, events) {
  for (const [event, data] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
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
    if (req.url !== "/v1/messages") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers["x-api-key"] !== "sk-from-command") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad x-api-key" } }));
      return;
    }
    if (req.headers["anthropic-version"] !== "2023-06-01") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "missing anthropic-version" } }));
      return;
    }
    const parsed = JSON.parse(body);
    state.requests.push(parsed);

    if (parsed.stream !== true) throw new Error("expected stream:true");
    if (typeof parsed.system !== "string" || parsed.system === "") throw new Error("expected system");

    // /compact-style summarization request: no tools offered.
    if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sseEvents(res, [
        ["message_start", { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 50 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SUMMARY: anthropic mock summary" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
      return;
    }

    const hasToolResult = parsed.messages.some((m) =>
      m.role === "user" && m.content.some?.((b) => b.type === "tool_result"),
    );

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });

    if (!hasToolResult) {
      sseEvents(res, [
        ["message_start", { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking the file now." } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path": "hel' } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'lo.txt"}' } }],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
      return;
    }

    let snippet = "";
    for (const m of parsed.messages) {
      if (m.role !== "user") continue;
      const arr = Array.isArray(m.content) ? m.content : [];
      for (const b of arr) {
        if (b.type === "tool_result") {
          const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          const match = text.match(/hello from hello\.txt/);
          if (match) snippet = match[0];
        }
      }
    }
    sseEvents(res, [
      ["message_start", { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 300 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `ANTHROPIC_OK:${snippet}` } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
  }
}

export default { server, state };
