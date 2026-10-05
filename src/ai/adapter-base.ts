// Shared plumbing for provider adapters: fetch with retries, error shaping,
// and the event-queue generator both adapters are built on.

import type { AssistantMessage, ChatRequest, StreamEvent } from "../types.js";

/** Never throws once iteration started — surfaces errors as StreamEvents. */
export abstract class AdapterBase {
  protected endpoint(request: ChatRequest, path: string): string {
    const base = request.model.provider.baseUrl.replace(/\/+$/, "");
    return `${base}${path}`;
  }

  protected async fetchWithRetry(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    isRetryable: (status: number) => boolean,
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const response = await fetch(url, { ...init, signal });
        if (response.ok) return response;
        if (!isRetryable(response.status) || attempt >= 3) {
          const detail = await readErrorBody(response);
          throw new ApiError(response.status, detail);
        }
      } catch (err) {
        if (signal?.aborted) throw new AbortedError();
        if (err instanceof ApiError) throw err;
        if (attempt >= 3) throw new ApiError(0, (err as Error).message);
      }
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 250, signal);
    }
  }

  protected emptyAssistant(): AssistantMessage {
    return { role: "assistant", content: [], stopReason: "stop" };
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export class AbortedError extends Error {}

async function readErrorBody(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    /* ignore */
  }
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message ?? parsed?.message ?? parsed?.error ?? body;
    if (typeof message !== "string") message = JSON.stringify(message);
  } catch {
    /* keep raw text */
  }
  const suffix = message ? `: ${truncate(message, 500)}` : "";
  return `HTTP ${response.status} ${response.statusText}${suffix}`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)} … [truncated ${s.length - max} chars]`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new AbortedError());
      },
      { once: true },
    );
  });
}

/** FIFO queue exposing an async iterator; adapter pushes events as they come. */
export class EventQueue {
  private events: StreamEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: StreamEvent): void {
    this.events.push(event);
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: (): Promise<IteratorResult<StreamEvent>> => {
        if (this.events.length > 0) return Promise.resolve({ value: this.events.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.wake = () => {
            this.wake = null;
            if (this.events.length > 0) resolve({ value: this.events.shift()!, done: false });
            else if (this.closed) resolve({ value: undefined, done: true });
          };
        });
      },
    };
  }
}
