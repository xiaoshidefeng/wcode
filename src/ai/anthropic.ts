// Anthropic Messages API streaming adapter (native SSE, no SDK).

import type { ChatRequest, ContentBlock, Message, StreamEvent, StreamFn, ToolSchema } from "../types.js";
import { AdapterBase, AbortedError, ApiError, EventQueue, STREAM_IDLE_MS, streamGuard } from "./adapter-base.js";
import { parseSse } from "./sse.js";

const ANTHROPIC_VERSION = "2023-06-01";

type AnthropicContentBase =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };

/** Wire content block; any block may carry a prompt-cache breakpoint. */
type AnthropicContent = AnthropicContentBase & { cache_control?: { type: "ephemeral" } };

/** A prompt-cache breakpoint: everything up to and including this block is cached. */
const CACHE_CONTROL = { type: "ephemeral" } as const;

function convertTools(tools: ToolSchema[], cache: boolean) {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    // Breakpoint after the last tool: the toolset is static across turns, so
    // this entry is always a cache hit (claude-code caches tools + system).
    ...(cache && i === tools.length - 1 ? { cache_control: CACHE_CONTROL } : {}),
  }));
}

function convertMessages(messages: Message[]): { role: "user" | "assistant"; content: AnthropicContent[] }[] {
  const out: { role: "user" | "assistant"; content: AnthropicContent[] }[] = [];
  const push = (role: "user" | "assistant", block: AnthropicContent | null) => {
    if (!block) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim() === "") continue;
        if (block.type === "text") push("assistant", { type: "text", text: block.text });
        else if (block.type === "thinking" && block.thinking.trim() !== "")
          push("assistant", { type: "thinking", thinking: block.thinking });
        else if (block.type === "tool_call")
          push("assistant", { type: "tool_use", id: block.id, name: block.name, input: safeJson(block.arguments) });
      }
    } else {
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim() === "") continue;
        if (block.type === "text") push("user", { type: "text", text: block.text });
        else if (block.type === "image")
          push("user", {
            type: "image",
            source: { type: "base64", media_type: block.media.mediaType, data: block.media.data },
          });
        else if (block.type === "tool_result") {
          const hasImages = block.content.some((c) => c.type === "image");
          const content = hasImages
            ? block.content.map((c) =>
                c.type === "text"
                  ? { type: "text", text: c.text }
                  : { type: "image", source: { type: "base64", media_type: c.media.mediaType, data: c.media.data } },
              )
            : block.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join("\n");
          push("user", {
            type: "tool_result",
            tool_use_id: block.toolCallId,
            content,
            ...(block.isError ? { is_error: true } : {}),
          });
        }
      }
    }
  }
  // Drop leading assistant message if the history somehow starts with one.
  while (out.length > 0 && out[0]!.role === "assistant") out.shift();
  return out;
}

function safeJson(s: string): unknown {
  try {
    return s.trim() === "" ? {} : JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Trailing cache breakpoint: mark the last block of the final message that
 * has content. The next request's prefix (everything before its own final
 * message) then matches this cache entry, so the transcript is billed at
 * cache-read rates instead of full input price.
 */
function cacheMessages(
  messages: { role: "user" | "assistant"; content: AnthropicContent[] }[],
  cache: boolean,
): { role: "user" | "assistant"; content: AnthropicContent[] }[] {
  if (!cache) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
    if (content.length === 0) continue;
    const last = content[content.length - 1]!;
    messages[i] = {
      ...messages[i]!,
      content: [...content.slice(0, -1), { ...last, cache_control: CACHE_CONTROL }],
    };
    break;
  }
  return messages;
}

class AnthropicAdapter extends AdapterBase {
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { model, options } = request;
    // Prompt caching (claude-code style): breakpoints on the last tool, the
    // system prompt and the final message. Each turn re-sends the whole
    // prefix, so a trailing breakpoint turns "re-bill the full history at
    // full price" into "cache-write once, cache-read at ~10% thereafter" —
    // cheaper, faster time-to-first-token, and fewer rate-limit hits.
    const cache = model.provider.promptCaching !== false;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      ...(model.apiKey ? { "x-api-key": model.apiKey } : {}),
      ...(model.provider.api === "anthropic-messages" && model.providerId === "anthropic"
        ? { "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14" }
        : {}),
      ...model.headers,
      ...options.headers,
    };
    const body: Record<string, unknown> = {
      model: model.model.id,
      max_tokens: options.maxTokens ?? model.model.maxTokens ?? 8192,
      stream: true,
      messages: cacheMessages(convertMessages(request.messages), cache),
    };
    if (request.tools.length > 0) body.tools = convertTools(request.tools, cache);
    if (request.system.trim() !== "") {
      body.system = cache
        ? [{ type: "text", text: request.system, cache_control: CACHE_CONTROL }]
        : request.system;
    }
    if (options.temperature !== undefined) body.temperature = options.temperature;

    const url = this.endpoint(request, "/v1/messages");
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
    let modelLabel = request.model.key;
    const push = (event: StreamEvent) => queue.push(event);
    // Idle guard: abort the body when the stream goes silent (user aborts
    // still propagate through it); guarded aborts are reported as a stall.
    const guard = streamGuard(signal);
    try {
      const response = await this.fetchWithRetry(
        url,
        { method: "POST", headers, body: JSON.stringify(body) },
        guard.signal,
        (status) => status === 429 || status === 500 || status === 502 || status === 503 || status === 529,
        request.options.onRetry,
      );
      const blocks: ContentBlock[] = [];
      partial = { role: "assistant", content: blocks, stopReason: "stop", model: modelLabel };
      push({ type: "start", partial });
      // Arm the idle window now: a response whose body never produces a
      // single chunk would otherwise never arm the guard inside the loop.
      guard.touch();

      const toolArgs = new Map<number, { id: string; name: string; json: string }>();
      let usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number } = {
        input: 0,
        output: 0,
      };

      for await (const sse of parseSse(response.body!)) {
        guard.touch(); // bytes arrived — re-arm the idle window
        if (guard.signal.aborted) throw new AbortedError();
        if (!sse.data) continue;
        let payload: any;
        try {
          payload = JSON.parse(sse.data);
        } catch {
          continue;
        }
        const type = sse.event ?? payload.type;
        switch (type) {
          case "message_start": {
            const u = payload.message?.usage ?? {};
            usage.input = u.input_tokens ?? 0;
            usage.cacheRead = u.cache_read_input_tokens;
            usage.cacheWrite = u.cache_creation_input_tokens;
            modelLabel = payload.message?.model ?? modelLabel;
            break;
          }
          case "content_block_start": {
            const b = payload.content_block;
            if (b?.type === "tool_use") {
              toolArgs.set(payload.index, { id: b.id, name: b.name, json: "" });
              push({ type: "tool_call_start", index: payload.index, partial });
            }
            break;
          }
          case "content_block_delta": {
            const d = payload.delta;
            if (d?.type === "text_delta") {
              ensureText(blocks).text += d.text ?? "";
              push({ type: "text_delta", delta: d.text ?? "", partial });
            } else if (d?.type === "thinking_delta") {
              ensureThinking(blocks).thinking += d.thinking ?? "";
              push({ type: "thinking_delta", delta: d.thinking ?? "", partial });
            } else if (d?.type === "input_json_delta") {
              const ta = toolArgs.get(payload.index);
              if (ta) {
                ta.json += d.partial_json ?? "";
                push({ type: "tool_call_delta", index: payload.index, argumentsDelta: d.partial_json ?? "", partial });
              }
            }
            break;
          }
          case "content_block_stop": {
            const ta = toolArgs.get(payload.index);
            if (ta) {
              blocks.push({ type: "tool_call", id: ta.id, name: ta.name, arguments: ta.json });
              toolArgs.delete(payload.index);
            }
            break;
          }
          case "message_delta": {
            const reason = payload.delta?.stop_reason;
            partial.stopReason =
              reason === "tool_use"
                ? "toolUse"
                : reason === "max_tokens"
                  ? "length"
                  : reason === "refusal"
                    ? "stop"
                    : "stop";
            if (payload.usage) {
              if (payload.usage.output_tokens !== undefined) usage.output = payload.usage.output_tokens;
              // Anthropic reports input tokens in message_start only, but some
              // Anthropic-compatible endpoints (zhipu) put the *real* usage —
              // input and cache reads alike — in message_delta and leave
              // message_start at zeros. Adopt whatever appears here; the
              // guards keep official-API values untouched.
              if (payload.usage.input_tokens > 0) usage.input = payload.usage.input_tokens;
              if (payload.usage.cache_read_input_tokens !== undefined) usage.cacheRead = payload.usage.cache_read_input_tokens;
              if (payload.usage.cache_creation_input_tokens !== undefined) usage.cacheWrite = payload.usage.cache_creation_input_tokens;
            }
            break;
          }
          case "message_stop":
            break;
          case "error": {
            const detail = payload.error?.message ?? JSON.stringify(payload);
            throw new ApiError(200, detail);
          }
          case "ping":
            break;
          default:
            break;
        }
      }
      partial.usage = {
        inputTokens: usage.input,
        outputTokens: usage.output,
        ...(usage.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
        ...(usage.cacheWrite !== undefined ? { cacheWriteTokens: usage.cacheWrite } : {}),
      };
      partial.model = modelLabel;
      if (guard.signal.aborted && !guard.timedOut()) {
        partial.stopReason = "aborted";
        push({ type: "error", reason: "aborted", errorMessage: "aborted by user", message: partial });
      } else {
        push({ type: "done", reason: partial.stopReason, message: partial });
      }
    } catch (err) {
      const stalled = guard.timedOut();
      const aborted = !stalled && (err instanceof AbortedError || guard.signal.aborted);
      partial.stopReason = aborted ? "aborted" : "error";
      partial.errorMessage = aborted
        ? "aborted by user"
        : stalled
          ? `stream idle for over ${Math.round(STREAM_IDLE_MS / 1000)}s — connection stalled, aborted`
          : describe(err);
      push({ type: "error", reason: aborted ? "aborted" : "error", errorMessage: partial.errorMessage, message: partial });
    } finally {
      guard.done();
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

const adapter = new AnthropicAdapter();
export const stream: StreamFn = (request) => adapter.stream(request);
