// Unified message / stream types shared by every provider adapter, the agent
// loop and the UI. Provider adapters translate these to/from wire formats.

export type ToolSchema = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
};

export type ImageMedia = { type: "base64"; mediaType: string; data: string };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_call"; id: string; name: string; arguments: string } // arguments: raw JSON string
  | { type: "tool_result"; toolCallId: string; content: ToolResultContent[]; isError?: boolean }
  | { type: "image"; media: ImageMedia };

export type ToolResultContent = { type: "text"; text: string } | { type: "image"; media: ImageMedia };

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export function text(s: string): { type: "text"; text: string } {
  return { type: "text", text: s };
}
export function toolResult(id: string, content: ToolResultContent[], isError = false): ContentBlock {
  return { type: "tool_result", toolCallId: id, content, isError };
}
export function userText(s: string): Message {
  return { role: "user", content: [text(s)] };
}
export function assistantMessage(content: ContentBlock[]): Message {
  return { role: "assistant", content };
}

// ---------------------------------------------------------------------------
// Stream events. Adapters emit these; every event carries the full partial
// assistant message so the UI never has to reassemble state (pi-style).
// ---------------------------------------------------------------------------

export type StopReason = "stop" | "toolUse" | "length" | "error" | "aborted";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  stopReason: StopReason;
  errorMessage?: string;
  usage?: Usage;
  /** Model/provider that produced this message, e.g. "zhipu/glm-4.6". */
  model?: string;
}

export type StreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "thinking_delta"; delta: string; partial: AssistantMessage }
  | { type: "tool_call_start"; index: number; partial: AssistantMessage }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string; partial: AssistantMessage }
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  | { type: "error"; reason: "error" | "aborted"; errorMessage: string; message: AssistantMessage };

// ---------------------------------------------------------------------------
// Model / provider records. These are pure data so that custom providers are
// just config entries, never code (pi-style).
// ---------------------------------------------------------------------------

/** Wire protocol spoken by a provider. Open string so new ones can be added. */
export type ApiType = "openai-completions" | "anthropic-messages" | (string & {});

export interface ModelConfig {
  /** Model id sent to the API, e.g. "glm-4.6". */
  id: string;
  /** Display name (defaults to id). */
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Model accepts image input. */
  input?: ("text" | "image")[];
  /** $ per million tokens, used only for the cost display. */
  cost?: { input?: number; output?: number };
}

/** Extra knobs for half-compatible vendors speaking the openai dialect. */
export interface OpenAiCompat {
  /** "max_completion_tokens" for OpenAI o-series/gpt-5 (default "max_tokens"). */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Set false for servers that reject stream_options.include_usage. */
  supportsUsageInStreaming?: boolean;
  /** Field the vendor streams chain-of-thought in (default reasoning_content). */
  reasoningField?: "reasoning_content" | "reasoning";
  /** Don't send the system role at all. */
  disableSystemRole?: boolean;
}

export interface ProviderConfig {
  /** Wire protocol, e.g. "openai-completions" or "anthropic-messages". */
  api: ApiType;
  name?: string;
  baseUrl: string;
  /** API key. Supports "${ENV}" / "$ENV" / "!command" value resolution. */
  apiKey?: string;
  /** Extra static headers. Values support the same resolution as apiKey. */
  headers?: Record<string, string>;
  /** Prefix for Authorization, default "Bearer" (openai) / header "x-api-key" (anthropic). */
  models: ModelConfig[];
  /** openai-completions dialect tweaks. */
  compat?: OpenAiCompat;
}

export interface ResolvedModel {
  /** "provider/modelId", used for display and selection. */
  key: string;
  providerId: string;
  provider: ProviderConfig;
  model: ModelConfig;
  apiKey?: string;
  headers: Record<string, string>;
}

export type AuthHeaderStyle = "bearer" | "x-api-key" | "none";

export interface StreamOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  /** 0 = off. Adapter decides how to map this onto its protocol. */
  thinking?: "off" | "normal";
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

// ---------------------------------------------------------------------------
// Chat request shape passed to adapters.
// ---------------------------------------------------------------------------

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  model: ResolvedModel;
  options: StreamOptions;
}

/**
 * Adapter contract: returns an async-iterable of StreamEvent and never throws
 * once iteration has begun — errors are reported as a final error event.
 */
export type StreamFn = (request: ChatRequest) => AsyncIterable<StreamEvent>;
