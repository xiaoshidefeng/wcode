// Prune-style compaction unit tests (opencode-inspired).
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, pruneOldToolResults, PRUNE_MARKER } from "../dist/agent/prune.js";
import { text, toolResult, userText } from "../dist/types.js";

function buildHistory(oldTurns, oldResultChars) {
  const msgs = [userText("fix the bug in app.ts")];
  for (let i = 0; i < oldTurns; i++) {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_call", id: `call_${i}`, name: "read", arguments: '{"path":"x.ts"}' }],
    });
    msgs.push({
      role: "user",
      content: [toolResult(`call_${i}`, [text("x".repeat(oldResultChars))])],
    });
  }
  // recent protected tail: a small exchange
  msgs.push(userText("now check the tests"));
  msgs.push({ role: "assistant", content: [{ type: "text", text: "sure" }] });
  return msgs;
}

test("prune: estimates tokens roughly as chars/4", () => {
  const msgs = [userText("x".repeat(400))];
  assert.equal(estimateTokens(msgs), 100);
});

test("prune: clears old tool outputs, protects recent tail and the task message", () => {
  const msgs = buildHistory(5, 4000); // 5 old turns × 4k chars
  const res = pruneOldToolResults(msgs, 1000, 200); // protect ~1k tokens (4k chars)
  assert.ok(res, "expected pruning to happen");
  assert.equal(res.messages[0], msgs[0], "task message untouched (same object)");
  assert.ok(res.prunedBlocks >= 1);
  assert.ok(res.charsFreed > 0);
  // every pruned tool_result now carries the marker inside its content
  const markers = res.messages
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result" && b.content.some((c) => c.type === "text" && c.text.includes(PRUNE_MARKER)));
  assert.ok(markers.length >= 1);
  // recent tail preserved verbatim
  assert.equal(res.messages[res.messages.length - 1].content[0].text, "sure");
  // big old outputs actually cleared
  const sizes = res.messages[2].content.map((b) => (b.type === "text" ? b.text.length : 0));
  assert.ok(sizes[0] < 4000, "old tool output should be much smaller now");
});

test("prune: leaves small tool results alone (min block size)", () => {
  const msgs = [
    userText("task"),
    { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "ls", arguments: "{}" }] },
    { role: "user", content: [toolResult("c1", [text("tiny")])] },
  ];
  const res = pruneOldToolResults(msgs, 10, 200);
  assert.equal(res, null, "tiny outputs are not worth pruning");
});

test("prune: returns null when everything fits in the protected budget", () => {
  const msgs = [userText("a"), { role: "assistant", content: [{ type: "text", text: "b" }] }];
  assert.equal(pruneOldToolResults(msgs, 5000), null);
});
