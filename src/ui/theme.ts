// Theme system: semantic color themes resolved onto render.ts's ANSI
// primitives by patching them in place — every fg./style. call site (TUI,
// plain mode, print mode) follows the active theme with zero per-site
// plumbing. opencode ships 32 named themes; wcode keeps three tuned for
// ANSI-16 so every terminal renders them.
//
//   wcode-dark   the classic palette (default)
//   wcode-light  darker hues for bright backgrounds
//   mono         no color at all (shape still carries the meaning)

import { fg, style } from "./render.js";

type Paint = (s: string) => string;

// Snapshot the primitives BEFORE any patching — theme paints compose from
// these, never from the (mutated) fg.* properties themselves.
const BASE = {
  cyan: fg.cyan,
  blue: fg.blue,
  magenta: fg.magenta,
  green: fg.green,
  yellow: fg.yellow,
  red: fg.red,
  bold: style.bold,
};

interface ThemeDef {
  description: string;
  accent: Paint; // borders, code spans, pickers, spinner glyphs
  user: Paint; // user echo, plan approval
  success: Paint;
  warning: Paint;
  error: Paint;
}

const THEMES: Record<string, ThemeDef> = {
  "wcode-dark": {
    description: "classic dark palette (default)",
    accent: BASE.cyan,
    user: BASE.magenta,
    success: BASE.green,
    warning: BASE.yellow,
    error: BASE.red,
  },
  "wcode-light": {
    description: "darker hues tuned for bright terminal backgrounds",
    accent: BASE.blue,
    user: (s) => BASE.bold(BASE.magenta(s)),
    success: (s) => BASE.bold(BASE.green(s)),
    warning: (s) => BASE.bold(BASE.yellow(s)),
    error: (s) => BASE.bold(BASE.red(s)),
  },
  mono: {
    description: "no color — weight and shape only (NO_COLOR always does this)",
    accent: (s) => s,
    user: BASE.bold,
    success: (s) => s,
    warning: BASE.bold,
    error: BASE.bold,
  },
};

let activeName = "wcode-dark";

/** Best-effort terminal background detection (rxvt-style COLORFGBG). */
export function detectBackground(): "dark" | "light" {
  const colorfgbg = process.env.COLORFGBG ?? "";
  const bg = Number(colorfgbg.split(";").pop());
  if (!Number.isFinite(bg)) return "dark";
  return bg === 7 || bg === 15 || (bg >= 3 && bg <= 6) ? "light" : "dark";
}

export function listThemes(): { name: string; description: string }[] {
  return Object.entries(THEMES).map(([name, t]) => ({ name, description: t.description }));
}

export function activeThemeName(): string {
  return activeName;
}

/** Apply a theme by name; false when unknown. */
export function applyTheme(name: string): boolean {
  const theme = THEMES[name];
  if (!theme) return false;
  fg.cyan = theme.accent;
  fg.blue = theme.accent;
  fg.magenta = theme.user;
  fg.green = theme.success;
  fg.yellow = theme.warning;
  fg.red = theme.error;
  activeName = name;
  return true;
}

/**
 * Startup selection: an explicitly saved theme wins, otherwise detect the
 * terminal background from COLORFGBG (dark by default).
 */
export function initTheme(saved: string | undefined): void {
  if (saved && applyTheme(saved)) return;
  applyTheme(detectBackground() === "light" ? "wcode-light" : "wcode-dark");
}
