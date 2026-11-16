// ANSI rendering helpers for the terminal UI.

const ENABLED = process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

function wrap(open: string, close: string, s: string): string {
  return ENABLED ? `${open}${s}${close}` : s;
}

export const fg = {
  red: (s: string) => wrap("\x1b[31m", "\x1b[39m", s),
  green: (s: string) => wrap("\x1b[32m", "\x1b[39m", s),
  yellow: (s: string) => wrap("\x1b[33m", "\x1b[39m", s),
  blue: (s: string) => wrap("\x1b[34m", "\x1b[39m", s),
  magenta: (s: string) => wrap("\x1b[35m", "\x1b[39m", s),
  cyan: (s: string) => wrap("\x1b[36m", "\x1b[39m", s),
  gray: (s: string) => wrap("\x1b[90m", "\x1b[39m", s),
};

export const style = {
  bold: (s: string) => wrap("\x1b[1m", "\x1b[22m", s),
  dim: (s: string) => wrap("\x1b[2m", "\x1b[22m", s),
  italic: (s: string) => wrap("\x1b[3m", "\x1b[23m", s),
};

export function clearLine(): void {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}
