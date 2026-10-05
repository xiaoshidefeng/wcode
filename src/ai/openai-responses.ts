// OpenAI Responses API streaming adapter (POST {baseUrl}/responses).
// Covers OpenAI's newer /v1/responses protocol and compatible gateways
// (e.g. Zhipu's /api/v1). Tool calls are flat items identified by call_id;
// reasoning streams as reasoning_text deltas.

import type { ChatRequest, ContentBlock, Message, StreamEvent, StreamFn } from "../types.js";
import { AdapterBase, AbortedError, ApiError, EventQueue } from "./adapter-base.js";
import { parseSse } from "./sse.js";

type ResponsesInputItem =
  | { role: "user" | "assistant"; content: ResponsesContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

function convertMessages(messages: Message[], useImages: boolean): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const parts: ResponsesContentPart[] = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text" && b.text.trim() !== "")
        .map((b) => ({ type: "output_text", text: b.text }));
      if (parts.length > 0) out.push({ role: "assistant", content: parts });
      for (const block of msg.content) {
        if (block.type === "tool_call") {
          out.push({ type: "function_call", call_id: block.id, name: block.name, arguments: block.arguments || "{}" });
        }
        // thinking blocks are not replayed — providers re-derive them
      }
    } else {
      const parts: ResponsesContentPart[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim() !== "") parts.push({ type: "input_text", text: block.text });
        else if (block.type === "image" && useImages)
          parts.push({ type: "input_image", image_url: `data:${block.media.mediaType};base64,${block.media.data}` });
      }
      // Function results must precede the user's own text.
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const output = block.content
            .map((c) => (c.type === "text" ? c.text : `[image: ${c.media.mediaType}]`))
            .join("\n");
          out.push({ type: "function_call_output", call_id: block.toolCallId, output });
        }
      }
      if (parts.length > 0) out.push({ role: "user", content: parts });
    }
  }
  return out;
}

class OpenAiResponsesAdapter extends AdapterBase {
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const { model, options } = request;
    const useImages = (model.model.input ?? ["text"]).includes("image");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
      ...model.headers,
      ...options.headers,
    };
    const body: Record<string, unknown> = {
      model: model.model.id,
      input: convertMessages(request.messages, useImages),
      stream: true,
      max_output_tokens: options.maxTokens ?? model.model.maxTokens ?? 8192,
    };
    if (request.system.trim() !== "") body.instructions = request.system;
    if (request.tools.length > 0) {
      // Responses API uses flat function tool definitions.
      body.tools = request.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    }
    if (options.temperature !== undefined) body.temperature = options.temperature;

    const url = this.endpoint(request, "/responses");
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
    const push = (event: StreamEvent) => queue.push(event);
    let partial = this.emptyAssistant();
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

      // output_index/item_id -> accumulating function call
      const calls = new Map<number, { callId: string; name: string; json: string }>();
      let stopReason: "stop" | "length" = "stop";
      let modelLabel = request.model.key;
      let usage: { input: number; output: number; cacheRead?: number } = { input: 0, output: 0 };

      for await (const sse of parseSse(response.body!)) {
        if (signal?.aborted) throw new AbortedError();
        if (!sse.data) continue;
        let payload: any;
        try {
          payload = JSON.parse(sse.data);
        } catch {
          continue;
        }
        const type = sse.event ?? payload.type;
        switch (type) {
          case "response.output_item.added": {
            const item = payload.item;
            if (item?.type === "function_call") {
              const idx = payload.output_index ?? calls.size;
              calls.set(idx, { callId: item.call_id ?? item.id ?? `call_${idx}`, name: item.name ?? "", json: "" });
              push({ type: "tool_call_start", index: idx, partial });
            }
            break;
          }
          case "response.reasoning_text.delta": {
            const target = ensureThinking(blocks);
            target.thinking += payload.delta ?? "";
            push({ type: "thinking_delta", delta: payload.delta ?? "", partial });
            break;
          }
          case "response.output_text.delta": {
            const target = ensureText(blocks);
            target.text += payload.delta ?? "";
            push({ type: "text_delta", delta: payload.delta ?? "", partial });
            break;
          }
          case "response.function_call_arguments.delta": {
            const idx = payload.output_index ?? 0;
            const call = calls.get(idx);
            if (call) {
              call.json += payload.delta ?? "";
              push({ type: "tool_call_delta", index: idx, argumentsDelta: payload.delta ?? "", partial });
            }
            break;
          }
          case "response.output_item.done": {
            const item = payload.item;
            if (item?.type === "function_call") {
              const existing = [...calls.values()].find((c) => c.callId === (item.call_id ?? item.id));
              const callId = item.call_id ?? item.id ?? existing?.callId ?? `call_${calls.size}`;
              const name = item.name ?? existing?.name ?? "";
              const args = typeof item.arguments === "string" ? item.arguments : (existing?.json ?? "");
              blocks.push({ type: "tool_call", id: callId, name, arguments: args });
            }
            break;
          }
          case "response.completed":
          case "response.failed": {
            const resp = payload.response ?? {};
            if (resp.model) modelLabel = resp.model;
            if (resp.status === "incomplete" || resp.incomplete_details) stopReason = "length";
            const u = resp.usage;
            if (u) {
              usage.input = u.input_tokens ?? 0;
              usage.output = u.output_tokens ?? 0;
              const cached = u.input_tokens_details?.cached_tokens;
              if (typeof cached === "number") usage.cacheRead = cached;
            }
            if (type === "response.failed") {
              const detail = resp.error?.message ?? "response failed";
              throw new ApiError(200, detail);
            }
            break;
          }
          case "error": {
            const detail = payload.error?.message ?? payload.message ?? JSON.stringify(payload).slice(0, 300);
            throw new ApiError(200, detail);
          }
          default:
            break;
        }
      }

      partial.usage = {
        inputTokens: usage.input,
        outputTokens: usage.output,
        ...(usage.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
      };
      partial.model = modelLabel;
      partial.stopReason = stopReason;
      if (signal?.aborted) {
        partial.stopReason = "aborted";
        push({ type: "error", reason: "aborted", errorMessage: "aborted by user", message: partial });
      } else {
        push({ type: "done", reason: partial.stopReason, message: partial });
      }
    } catch (err) {
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

const adapter = new OpenAiResponsesAdapter();
export const stream: StreamFn = (request) => adapter.stream(request);
