// Minimal MCP server over stdio for tests: newline-delimited JSON-RPC.
// Exposes one tool `echo` that answers "echo:<text>"; `ping` answers "pong".
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const tools = [
  {
    name: "echo",
    description: "Echo the given text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "ping",
    description: "Always answers pong",
    inputSchema: { type: "object", properties: {} },
  },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

rl.on("line", (line) => {
  if (line.trim() === "") return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof msg.id !== "number") return; // notification
  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "1.0.0" },
      });
      break;
    case "tools/list":
      reply(msg.id, { tools });
      break;
    case "tools/call": {
      const args = msg.params?.arguments ?? {};
      const text =
        msg.params?.name === "echo" ? `echo:${args.text ?? ""}` : msg.params?.name === "ping" ? "pong" : `unknown tool`;
      reply(msg.id, { content: [{ type: "text", text }], isError: false });
      break;
    }
    default:
      reply(msg.id, {});
  }
});

// Keep stdin flowing; exit when the parent closes it.
rl.on("close", () => process.exit(0));
