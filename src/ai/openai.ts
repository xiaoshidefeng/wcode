// OpenAI-compatible chat-completions streaming adapter. Covers OpenAI itself
// plus the dozens of vendors speaking this dialect (DeepSeek, Moonshot, Qwen,
// GLM, OpenRouter, Ollama, vLLM, ...).

import type { ChatRequest, ContentBlock, Message, OpenAiCompat, StreamEvent, StreamFn } from "../types.js";
import { AdapterBase, AbortedError, ApiError, EventQueue } from "./adapter-base.js";
import { parseSse } from "./sse.js";

type OaiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OaiContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OaiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OaiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

function compat(request: ChatRequest): OpenAiCompat {
  return request.model.provider.compat ?? {};
}

function convertMessages(messages: Message[], system: string, useImages: boolean, disableSystem: boolean): OaiMessage[] {
  const out: OaiMessage[] = [];
  const systemRole = disableSystem ? "user" : "system";
  if (system.trim() !== "") out.push({ role: systemRole, content: system } as OaiMessage);
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const text = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls: OaiToolCall[] = msg.content
        .filter((b): b is { type: "tool_call"; id: string; name: string; arguments: string } => b.type === "tool_call")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: b.arguments || "{}" } }));
      if (toolCalls.length > 0 || text !== "") {
        out.push({
          role: "assistant",
          content: text === "" ? null : text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    } else {
      const toolResults = msg.content.filter((b) => b.type === "tool_result");
      // Tool results first: they must directly follow the assistant tool_calls.
      for (const block of toolResults) {
        if (block.type !== "tool_result") continue;
        const content = block.content
          .map((c) => (c.type === "text" ? c.text : `[image: ${c.media.mediaType}]`))
          .join("\n");
        out.push({ role: "tool", tool_call_id: block.toolCallId, content });
      }
      const parts: OaiContentPart[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim() !== "") parts.push({ type: "text", text: block.text });
        else if (block.type === "image" && useImages)
          parts.push({ type: "image_url", image_url: { url: `data:${block.media.mediaType};base64,${block.media.data}` } });
      }
      if (parts.length > 0) {
        out.push(parts.length === 1 && parts[0]!.type === "text"
          ? { role: "user", content: parts[0]!.text }
          : { role: "user", content: parts });
      }
    }
  }
  return out;
}

class OpenAiAdapter extends AdapterBase {
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { model, options } = request;
    const cfg = compat(request);
    const useImages = (model.model.input ?? ["text"]).includes("image");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
      ...model.headers,
      ...options.headers,
    };
    const maxTokensField = cfg.maxTokensField ?? "max_tokens";
    const body: Record<string, unknown> = {
      model: model.model.id,
      stream: true,
      messages: convertMessages(request.messages, request.system, useImages, cfg.disableSystemRole ?? false),
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    body[maxTokensField] = options.maxTokens ?? model.model.maxTokens ?? 8192;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (cfg.supportsUsageInStreaming !== false) body.stream_options = { include_usage: true };

    const url = this.endpoint(request, "/chat/completions");
    const queue = new EventQueue();
    void this.pump(url, headers, body, options.signal, request, queue);
    yield* queue;
  }

  private async pump(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal | undefined,
    request: ChatRequest,
    queue: EventQueue,
  ): Promise<void> {
    let partial = this.emptyAssistant();
    const push = (event: StreamEvent) => queue.push(event);
    const cfg = compat(request);
    try {
      const response = await this.fetchWithRetry(
        url,
        { method: "POST", headers, body: JSON.stringify(body) },
        signal,
        (status) => status === 429 || (status >= 500 && status <= 504),
      );
      const blocks: ContentBlock[] = [];
      partial = { role: "assistant", content: blocks, stopReason: "stop", model: request.model.key };
      push({ type: "start", partial });

      // tool call index -> accumulating call
      const toolCalls = new Map<number, { id: string; name: string; json: string }>();
      let finishReason: string | null = null;
      let usage: { input: number; output: number; cacheRead?: number } = { input: 0, output: 0 };
      let modelLabel = request.model.key;

      for await (const sse of parseSse(response.body!)) {
        if (signal?.aborted) throw new AbortedError();
        if (!sse.data || sse.data === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(sse.data);
        } catch {
          continue;
        }
        if (chunk.model) modelLabel = chunk.model;
        if (chunk.usage) {
          usage.input = chunk.usage.prompt_tokens ?? usage.input;
          usage.output = chunk.usage.completion_tokens ?? usage.output;
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
          if (typeof cached === "number") usage.cacheRead = cached;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        const reasoning = delta[cfg.reasoningField ?? "reasoning_content"] ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning !== "") {
          ensureThinking(blocks).thinking += reasoning;
          push({ type: "thinking_delta", delta: reasoning, partial });
        }
        if (typeof delta.content === "string" && delta.content !== "") {
          ensureText(blocks).text += delta.content;
          push({ type: "text_delta", delta: delta.content, partial });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let acc = toolCalls.get(idx);
            if (!acc) {
              acc = { id: tc.id ?? `call_${idx}_${Date.now()}`, name: "", json: "" };
              toolCalls.set(idx, acc);
              push({ type: "tool_call_start", index: idx, partial });
            }
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) {
              acc.json += tc.function.arguments;
              push({ type: "tool_call_delta", index: idx, argumentsDelta: tc.function.arguments, partial });
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      // Flush accumulated tool calls in index order.
      for (const [, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        blocks.push({ type: "tool_call", id: tc.id, name: tc.name, arguments: tc.json });
      }
      partial.stopReason =
        finishReason === "tool_calls"
          ? "toolUse"
          : finishReason === "length"
            ? "length"
            : finishReason === "aborted"
              ? "aborted"
              : "stop";
      partial.usage = {
        inputTokens: usage.input,
        outputTokens: usage.output,
        ...(usage.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
      };
      partial.model = modelLabel;
      if (signal?.aborted) {
        partial.stopReason = "aborted";
        push({ type: "error", reason: "aborted", errorMessage: "aborted by user", message: partial });
      } else {
        push({ type: "done", reason: partial.stopReason, message: partial });
      }
    } catch (err) {
      partial.stopReason = "error";
      const aborted = err instanceof AbortedError || signal?.aborted;
      partial.stopReason = aborted ? "aborted" : "error";
      partial.errorMessage = aborted ? "aborted by user" : describe(err);
      push({ type: "error", reason: aborted ? "aborted" : "error", errorMessage: partial.errorMessage, message: partial });
    } finally {
      queue.close();
    }
  }
}

function ensureText(blocks: ContentBlock[]): { type: "text"; text: string } {
  const last = blocks[blocks.length - 1];
  if (last && last.type === "text") return last;
  const fresh = { type: "text" as const, text: "" };
  blocks.push(fresh);
  return fresh;
}
function ensureThinking(blocks: ContentBlock[]): { type: "thinking"; thinking: string } {
  const last = blocks[blocks.length - 1];
  if (last && last.type === "thinking") return last;
  const fresh = { type: "thinking" as const, thinking: "" };
  blocks.push(fresh);
  return fresh;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return (err as Error)?.message ?? String(err);
}

const adapter = new OpenAiAdapter();
export const stream: StreamFn = (request) => adapter.stream(request);
