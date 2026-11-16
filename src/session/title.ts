// Session titles: a one-shot small LLM call that names the conversation after
// the first exchange (opencode session/title.ts: tiny context, 100-char cap,
// first non-empty output line only). Failures are silent — a title is sugar.

import type { Message, ResolvedModel } from "../types.js";
import { text } from "../types.js";
import { getAdapter } from "../ai/index.js";

const MAX_TITLE_LENGTH = 100;
const MESSAGE_SLICE = 2_000;

function textOf(message: Message | undefined): string {
  if (!message) return "";
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function isUserTurn(message: Message): boolean {
  return message.role === "user" && !message.content.some((b) => b.type === "tool_result");
}

/** Generate a short session title; null when the model or network fails. */
export async function generateSessionTitle(messages: Message[], model: ResolvedModel): Promise<string | null> {
  const firstUser = messages.find((m) => isUserTurn(m) && !textOf(m).startsWith("<context_summary>"));
  if (!firstUser) return null;
  const firstAssistant = messages.find(
    (m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text.trim() !== ""),
  );
  const parts = [
    "Name this conversation in 3-8 words. Output only the title: no quotes, no trailing punctuation, in the same language as the conversation.",
    "",
    `<message>\n${textOf(firstUser).slice(0, MESSAGE_SLICE)}\n</message>`,
  ];
  const assistantText = textOf(firstAssistant).trim();
  if (assistantText !== "") parts.push(`<conversation>\n${assistantText.slice(0, MESSAGE_SLICE)}\n</conversation>`);
  try {
    const adapter = getAdapter(model.provider.api);
    let out = "";
    for await (const event of adapter({
      system: "You generate short conversation titles. Output only the title text.",
      messages: [{ role: "user", content: [text(parts.join("\n"))] }],
      tools: [],
      model,
      options: { maxTokens: 60 },
    })) {
      if (event.type === "text_delta") out += event.delta;
      if (event.type === "error") return null;
    }
    const line = out.split("\n").find((l) => l.trim() !== "");
    const title = line?.trim().replace(/^["'`]+|["'`]+$/g, "") ?? "";
    if (title === "") return null;
    return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
  } catch {
    return null;
  }
}
