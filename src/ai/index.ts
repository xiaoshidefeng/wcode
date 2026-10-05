// Adapter registry: wire-protocol name -> StreamFn. Adding a new protocol
// means adding one module and one entry here.

import type { ApiType, StreamFn } from "../types.js";
import { stream as anthropicStream } from "./anthropic.js";
import { stream as openaiStream } from "./openai.js";
import { stream as openaiResponsesStream } from "./openai-responses.js";

const adapters: Record<string, StreamFn> = {
  "anthropic-messages": anthropicStream,
  "openai-completions": openaiStream,
  "openai-responses": openaiResponsesStream,
};

export function getAdapter(api: ApiType): StreamFn {
  const adapter = adapters[api];
  if (!adapter) {
    throw new Error(
      `unknown api "${api}". Supported: ${Object.keys(adapters).join(", ")}. ` +
        `Add a custom one in src/ai/ if you need a new protocol.`,
    );
  }
  return adapter;
}
