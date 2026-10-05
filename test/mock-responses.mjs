// Mock OpenAI Responses API server (/responses) for offline tests.
// Turn 1: reasoning deltas + a read function_call (arguments in two deltas).
// Turn 2 (function_call_output present): text answer RESPONSES_OK:<snippet>.
// No-tools request (compact): returns a summary text.
import http from "node:http";

const state = { requests: [] };

function sse(res, events) {
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.write("data: [DONE]\n\n");
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
    if (!req.url.endsWith("/responses")) {
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

    if (parsed.stream !== true) throw new Error("expected stream:true");
    if (!Array.isArray(parsed.input)) throw new Error("expected input array");

    const hasToolOutput = parsed.input.some((i) => i.type === "function_call_output");
    if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
      sse(res, [
        ["response.created", { type: "response.created", response: { status: "in_progress", output: [] } }],
        ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", content: [] } }],
        ["response.output_text.delta", { type: "response.output_text.delta", delta: "SUMMARY: responses mock summary" }],
        ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "SUMMARY: responses mock summary" }] } }],
        ["response.completed", { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } }],
      ]);
      return;
    }

    const callId = "call_mock_1";
    if (!hasToolOutput) {
      const events = [
        ["response.created", { type: "response.created", response: { status: "in_progress", output: [] } }],
        ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", content: [] } }],
        ["response.reasoning_text.delta", { type: "response.reasoning_text.delta", delta: "Let me read it." }],
        ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", content: [{ type: "reasoning_text", text: "Let me read it." }] } }],
        ["response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: callId, id: `fc_${callId}`, name: "read", arguments: "", status: "in_progress" } }],
        ["response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":' }],
        ["response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 1, delta: ' "hello.txt"}' }],
        ["response.function_call_arguments.done", { type: "response.function_call_arguments.done", output_index: 1, arguments: '{"path": "hello.txt"}' }],
        ["response.output_item.done", { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: callId, name: "read", arguments: '{"path": "hello.txt"}', status: "completed" } }],
        ["response.completed", { type: "response.completed", response: { status: "completed", usage: { input_tokens: 100, output_tokens: 20 } } }],
      ];
      sse(res, events);
      return;
    }

    let snippet = "";
    for (const item of parsed.input) {
      if (item.type === "function_call_output" && String(item.output).includes("hello from hello.txt")) {
        snippet = "hello from hello.txt";
      }
    }
    sse(res, [
      ["response.created", { type: "response.created", response: { status: "in_progress", output: [] } }],
      ["response.output_text.delta", { type: "response.output_text.delta", delta: `RESPONSES_OK:${snippet}` }],
      ["response.completed", { type: "response.completed", response: { status: "completed", usage: { input_tokens: 200, output_tokens: 10 } } }],
    ]);
  }
}

export default { server, state };
