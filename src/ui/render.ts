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

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** In-place single-line status (spinner) writer. */
export class StatusLine {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = "";
  private active = false;

  start(label: string): void {
    this.stop();
    if (!process.stdout.isTTY) return;
    this.active = true;
    this.label = label;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.draw(SPINNER_FRAMES[this.frame]!);
    }, 90);
    this.draw(SPINNER_FRAMES[0]!);
  }

  update(label: string): void {
    if (!this.active) return;
    this.label = label;
    this.draw(SPINNER_FRAMES[this.frame]!);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.active) {
      clearLine();
      this.active = false;
    }
  }

  private draw(icon: string): void {
    const width = process.stdout.columns ?? 80;
    let text = `${icon} ${this.label}`;
    if (text.length > width - 2) text = `${text.slice(0, width - 5)}…`;
    process.stdout.write(`\r\x1b[2K${fg.cyan(text)}`);
  }
}

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

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
