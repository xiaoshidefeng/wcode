// Prune-style context compaction (opencode-inspired): replace old tool
// outputs with short markers while protecting the most recent tokens.
// Pure function — the caller decides when to apply it.

import type { Message } from "../types.js";

export const PRUNE_MARKER = "[Old tool output cleared to free context]";

export interface PruneResult {
  messages: Message[];
  prunedBlocks: number;
  charsFreed: number;
}

/** Rough token estimate: chars / 4, images counted as a fixed allowance. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "thinking") chars += b.thinking.length;
      else if (b.type === "tool_call") chars += b.arguments.length + b.name.length + 40;
      else if (b.type === "tool_result") {
        for (const c of b.content) chars += c.type === "text" ? c.text.length : 800;
      } else chars += 100;
    }
  }
  return Math.ceil(chars / 4);
}

function messageChars(m: Message): number {
  let chars = 0;
  for (const b of m.content) {
    if (b.type === "text") chars += b.text.length;
    else if (b.type === "thinking") chars += b.thinking.length;
    else if (b.type === "tool_result") {
      for (const c of b.content) chars += c.type === "text" ? c.text.length : 800;
    } else chars += 100;
  }
  return chars;
}

function toolResultSize(b: { content: { type: string; text?: string }[] }): number {
  return b.content.reduce((n, c) => n + (c.type === "text" ? c.text!.length : 800), 0);
}

/**
 * Replace tool_result contents older than the protected tail with a marker.
 * Text blocks smaller than minBlockChars are left alone (cheap anyway).
 * The first user message (the task) is never pruned. Returns null when
 * there is nothing worth pruning.
 */
export function pruneOldToolResults(messages: Message[], protectTokens = 30_000, minBlockChars = 200): PruneResult | null {
  let budget = protectTokens * 4; // chars
  let cutoff = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const chars = messageChars(messages[i]!);
    if (chars > budget) {
      cutoff = i + 1;
      break;
    }
    budget -= chars;
    cutoff = i;
  }
  if (cutoff <= 0) return null;

  let prunedBlocks = 0;
  let charsFreed = 0;
  const out = messages.map((m, idx) => {
    if (idx >= cutoff || m.role !== "user") return m;
    if (idx === 0) return m; // never touch the task message
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type !== "tool_result") return b;
      const size = toolResultSize(b);
      if (size <= minBlockChars) return b;
      prunedBlocks++;
      charsFreed += size;
      changed = true;
      return { ...b, content: [{ type: "text" as const, text: `${PRUNE_MARKER} (${size} chars freed)` }] };
    });
    return changed ? { ...m, content } : m;
  });
  if (prunedBlocks === 0) return null;
  return { messages: out, prunedBlocks, charsFreed };
}
