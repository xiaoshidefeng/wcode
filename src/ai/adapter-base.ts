// Shared plumbing for provider adapters: fetch with retries, error shaping,
// and the event-queue generator both adapters are built on.

import type { AssistantMessage, ChatRequest, StreamEvent } from "../types.js";

// Retry policy (aligned with opencode's model-retry): exponential backoff
// from 2s capped at 10s, a handful of attempts, jittered; a provider
// Retry-After is honored but capped so a bogus value can't stall a session.
// WCODE_RETRY_BASE_MS shrinks the curve for tests.
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = Number(process.env.WCODE_RETRY_BASE_MS) || 2000;
const BACKOFF_CAP_MS = Math.max(BACKOFF_BASE_MS * 5, 10_000);
const RETRY_AFTER_CAP_MS = 15 * 60_000;

function retryAfterDelay(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

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
    onRetry?: (attempt: number, delayMs: number, reason: string) => void,
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      attempt++;
      let reason = "";
      let retryAfterMs: number | undefined;
      try {
        const response = await fetch(url, { ...init, signal });
        if (response.ok) return response;
        if (!isRetryable(response.status) || attempt >= MAX_ATTEMPTS) {
          const detail = await readErrorBody(response);
          throw new ApiError(response.status, detail);
        }
        reason = `HTTP ${response.status}`;
        // A provider Retry-After wins over our backoff curve, but is capped —
        // a bogus "retry in an hour" must not stall the session.
        retryAfterMs = retryAfterDelay(response);
        // Drop the rejected body before sleeping; holding it pins the socket
        // until GC and can starve the connection pool.
        void response.body?.cancel().catch(() => {});
      } catch (err) {
        if (signal?.aborted) throw new AbortedError();
        if (err instanceof ApiError) throw err;
        if (attempt >= MAX_ATTEMPTS) throw new ApiError(0, (err as Error).message);
        reason = (err as Error)?.message ?? "network error";
      }
      const backoff = retryAfterMs ?? Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
      const delay = backoff + Math.random() * 250;
      onRetry?.(attempt, delay, reason);
      await sleep(delay, signal);
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

// Once the response is streaming, fetchWithRetry no longer protects us: a
// half-open connection (provider hang, proxy black hole) can stall the SSE
// body with no error and no data, and `for await` waits forever. With
// parallel task subagents one stalled stream holds the parent's Promise.all
// forever — the session freezes with no output and the queue never drains.
// The guard aborts the body when no bytes arrive for a window; the adapter's
// catch turns that into a normal stream error (retryable on the next turn).
// 0 disables; WCODE_STREAM_IDLE_MS overrides (tests shrink it).
export const STREAM_IDLE_MS = Number(process.env.WCODE_STREAM_IDLE_MS) || 180_000;

export interface StreamGuard {
  /** Pass to fetchWithRetry and check inside the stream loop. */
  signal: AbortSignal;
  /** Arm/re-arm the idle timer — call on every received chunk. */
  touch: () => void;
  /** True when the guard itself aborted the stream (idle window expired). */
  timedOut: () => boolean;
  /** Stop the timer when the stream is over. */
  done: () => void;
}

export function streamGuard(outer: AbortSignal | undefined, idleMs = STREAM_IDLE_MS): StreamGuard {
  const inner = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  if (outer) {
    if (outer.aborted) inner.abort();
    else outer.addEventListener("abort", () => inner.abort(), { once: true });
  }
  return {
    signal: inner.signal,
    touch: (): void => {
      stop();
      if (idleMs <= 0) return;
      timer = setTimeout(() => {
        timedOut = true;
        inner.abort();
      }, idleMs);
    },
    timedOut: () => timedOut,
    done: stop,
  };
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
