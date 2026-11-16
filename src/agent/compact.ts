// Conversation compaction: LLM summary of the transcript (for /compact and
// the automatic trigger), plus the trigger math. Prune (agent/prune.ts) stays
// the cheaper first line of defense; compaction replaces the transcript with
// a structured summary while keeping the most recent exchanges verbatim.
//
// Trigger uses a reserve model (opencode compaction): fire when the estimated
// context crosses window − max(15% of window, 16k tokens), so there is always
// headroom for the answer.

import type { Message, ResolvedModel } from "../types.js";
import { text } from "../types.js";
import { getAdapter } from "../ai/index.js";
import { estimateTokens } from "./prune.js";

/** Share of the context window kept as headroom below the trigger. */
const RESERVE_SHARE = 0.15;
/** Minimum headroom in tokens once the window is at least twice this size. */
const RESERVE_MIN_TOKENS = 16_000;
/** Fallback ceiling (tokens) when the model has no known context window. */
const FALLBACK_CEILING_TOKENS = 100_000;
/** Recent tokens kept verbatim after compaction, anchored at a user turn. */
export const COMPACT_KEEP_TAIL_TOKENS = 12_000;

/**
 * Estimated context size at which compaction should fire: the window minus
 * the reserved headroom (opencode's reserve model, replacing a flat %).
 */
export function compactionCeiling(contextWindow?: number): number {
  if (!contextWindow || contextWindow <= 0) return FALLBACK_CEILING_TOKENS;
  const reserve = Math.max(
    Math.floor(contextWindow * RESERVE_SHARE),
    contextWindow >= RESERVE_MIN_TOKENS * 2 ? RESERVE_MIN_TOKENS : 0,
  );
  return Math.max(0, contextWindow - reserve);
}

export function shouldAutoCompact(messages: Message[], model: ResolvedModel): boolean {
  // Compacting a tiny conversation loses more than it frees.
  if (messages.length < 8) return false;
  return estimateTokens(messages) > compactionCeiling(model.model.contextWindow);
}

function isUserTurn(message: Message): boolean {
  return message.role === "user" && !message.content.some((b) => b.type === "tool_result");
}

function isToolResultTurn(message: Message): boolean {
  return message.role === "user" && message.content.some((b) => b.type === "tool_result");
}

/**
 * Split the transcript into the part to summarize (head) and the recent
 * exchanges kept verbatim (tail). The cut is anchored at a user turn so a
 * tool call/result pair is never separated from the request that caused it,
 * and the tail never opens with orphaned tool results (providers reject a
 * tool result whose tool_call is missing).
 */
export function splitForCompaction(messages: Message[], keepTokens = COMPACT_KEEP_TAIL_TOKENS): { head: Message[]; tail: Message[] } {
  let est = 0;
  let cut = messages.length;
  // i >= 1: the head keeps at least one message to summarize.
  for (let i = messages.length - 1; i >= 1; i--) {
    const message = messages[i]!;
    est += estimateTokens([message]);
    cut = i;
    if (est >= keepTokens && isUserTurn(message)) break;
  }
  while (cut < messages.length && isToolResultTurn(messages[cut]!)) cut++;
  return { head: messages.slice(0, cut), tail: messages.slice(cut) };
}

const SUMMARY_TEMPLATE = [
  "Summarize this conversation so work can continue seamlessly in a fresh context.",
  "Write in the same language as the conversation. Output markdown with exactly these sections (skip a section only if there is truly nothing to report):",
  "",
  "## Objective",
  "## Decisions",
  "## Work State", // and note Completed / Active / Blocked items
  "## Next Move",
  "## Relevant Files", // max 15, with paths
  "## Important Context",
  "",
  "Preserve exact file paths, symbols, commands, error strings, URLs and identifiers — they are load-bearing. Output only the summary.",
].join("\n");

/** Summarize the conversation via a tool-less LLM call. */
export async function summarizeConversation(messages: Message[], model: ResolvedModel): Promise<string> {
  const adapter = getAdapter(model.provider.api);
  const request = {
    system: SUMMARY_TEMPLATE,
    messages: [
      ...messages,
      {
        role: "user" as const,
        content: [text("Summarize this conversation now, following the system instructions.")],
      },
    ],
    tools: [],
    model,
    options: { maxTokens: 8192 } as const,
  };
  let summaryText = "";
  for await (const event of adapter(request)) {
    if (event.type === "text_delta") summaryText += event.delta;
    if (event.type === "error") throw new Error(event.errorMessage);
  }
  if (summaryText.trim() === "") throw new Error("model returned an empty summary");
  return summaryText.trim();
}

/**
 * Messages replacement used by /compact and auto-compact: a summary message
 * followed by the recent exchanges kept verbatim (opencode keeps a tail too).
 */
export function compactedMessages(summary: string, tail: Message[] = []): Message[] {
  return [
    {
      role: "user",
      content: [
        text(
          `<context_summary>\n${summary}\n</context_summary>\n\nThe conversation so far is summarized above; the messages that follow are its most recent exchanges, kept verbatim. Continue helping the user; they may refer to details from the summary.`,
        ),
      ],
    },
    ...tail,
  ];
}

/** Compact the transcript into summary + kept tail. Throws on summary failure. */
export async function compactMessages(messages: Message[], model: ResolvedModel): Promise<Message[]> {
  const { head, tail } = splitForCompaction(messages);
  const summary = await summarizeConversation(head, model);
  return compactedMessages(summary, tail);
}
