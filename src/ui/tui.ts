// TUI frontend — the Claude-Code-style experience: bordered input box pinned
// to the bottom, streaming output scrolling above it, status line, slash
// command hints, markdown-lite rendering, Esc/Ctrl+C interrupt.
//
// Hand-rolled on raw-mode key handling (no readline): we own the whole input
// area, so the box can wrap the cursor. Multi-line input works for pastes
// (bracketed paste) and backslash continuations.

import { StringDecoder } from "node:string_decoder";
import { existsSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { AgentEvent } from "../agent/agent.js";
import type { SessionOptions } from "./session.js";
import { SessionController, SHORTCUTS, SLASH_COMMANDS, type PermissionAnswer, type ToastKind } from "./session.js";
import { fg, style } from "./render.js";
import { VERSION } from "../version.js";
import { CONFIG_DIR } from "../config.js";
import { loadCustomCommands } from "../commands.js";
import { listSessions } from "../session/store.js";
import { listFiles } from "../tools/util.js";
import { KeyStream, type ParsedKey } from "./keys.js";
import { fuzzyFilter } from "./fuzzy.js";
import { initTheme, listThemes, activeThemeName } from "./theme.js";
import type { ToolPermissionRequest } from "../tools/types.js";
import type { ModelEntry } from "../config.js";

// ---------------------------------------------------------------------------
// Display-width helpers (CJK chars occupy 2 terminal columns)
// ---------------------------------------------------------------------------

/** One fuzzy-searchable palette entry (command or action). */
type PaletteItem = { name: string; description: string; run: () => void | Promise<void> };

// Flicker control: hide the cursor across redraws and ask the terminal to
// synchronize the update (\x1b[?2026h — unsupported terminals just ignore it).
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

function charWidth(code: number): number {
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals … Yijing
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compat ideographs
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

function padToWidth(s: string, width: number): string {
  const pad = width - stringWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Markdown-lite line styling (applied when a streamed line completes)
// ---------------------------------------------------------------------------

class LineBufferStreamer {
  private buffer = "";
  private inFence = false;

  constructor(private readonly styleLine: (line: string, inFence: boolean) => string) {}

  feed(delta: string, emit: (line: string) => void): void {
    this.buffer += delta;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.emitLine(line, emit);
    }
  }

  flush(emit: (line: string) => void): void {
    if (this.buffer !== "") {
      this.emitLine(this.buffer, emit);
      this.buffer = "";
    }
  }

  hasBuffer(): boolean {
    return this.buffer !== "";
  }

  private emitLine(line: string, emit: (line: string) => void): void {
    emit(this.styleLine(line, this.inFence));
    if (/^\s*(```|~~~)/.test(line)) this.inFence = !this.inFence;
  }
}

function styleMarkdownLine(line: string, inFence: boolean): string {
  if (inFence) return style.dim(line);
  const header = line.match(/^(#{1,4})\s+(.*)$/);
  if (header) return style.bold(fg.cyan(line));
  const bullet = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
  if (bullet) {
    const [, indent, marker, rest] = bullet;
    return `${indent}${fg.cyan(marker)} ${styleInline(rest)}`;
  }
  return styleInline(line);
}

function styleThinkingLine(line: string): string {
  return style.dim(style.italic(line));
}

function styleInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, code) => fg.cyan(String(code)))
    .replace(/\*\*([^*]+)\*\*/g, (_m, b) => style.bold(String(b)));
}

// ---------------------------------------------------------------------------
// Raw input editor: buffer is an array of lines; cursor is (line, col).
// ---------------------------------------------------------------------------

interface EditorState {
  lines: string[];
  line: number;
  col: number;
}

class RawEditor {
  state: EditorState = { lines: [""], line: 0, col: 0 };
  private history: string[] = [];
  private historyIndex = -1;
  private historyDraft = "";
  onKeysRaw: ((data: string) => void) | null = null; // intercept hook (busy keys)
  /** Fired after a submitted line enters the history (persistence hook). */
  onHistoryPush: ((text: string) => void) | null = null;
  enabled = true;

  get isSingleLine(): boolean {
    return this.state.lines.length === 1;
  }

  get text(): string {
    return this.state.lines.join("\n");
  }

  reset(text = ""): void {
    this.state = text === "" ? { lines: [""], line: 0, col: 0 } : { lines: text.split("\n"), line: 0, col: 0 };
    this.historyIndex = -1;
  }

  isEmpty(): boolean {
    return this.state.lines.every((l) => l === "");
  }

  /** Load a persisted history (oldest first). */
  seedHistory(items: string[]): void {
    this.history = [...items];
  }

  handleKey(data: string): "submit" | "abort" | "quit" | "tab" | null {
    const st = this.state;
    const line = () => st.lines[st.line]!;
    const setLine = (s: string) => (st.lines[st.line] = s);

    if (data === "\r") {
      // Trailing backslash = soft line break (multi-line input without paste).
      const cur = line();
      if (cur.endsWith("\\") && !cur.endsWith("\\\\")) {
        st.lines[st.line] = cur.slice(0, -1);
        st.lines.splice(st.line + 1, 0, "");
        st.line++;
        st.col = 0;
        return null;
      }
      return "submit";
    }
    if (data === "\n") {
      // ctrl+j: insert a newline (return submits).
      const cur = line();
      st.lines[st.line] = cur.slice(0, st.col);
      st.lines.splice(st.line + 1, 0, cur.slice(st.col));
      st.line++;
      st.col = 0;
      return null;
    }
    if (data === "\x7f") {
      // backspace
      if (st.col > 0) {
        setLine(line().slice(0, st.col - 1) + line().slice(st.col));
        st.col--;
      } else if (st.line > 0) {
        const prev = st.lines[st.line - 1]!;
        st.col = prev.length;
        st.lines[st.line - 1] = prev + line();
        st.lines.splice(st.line, 1);
        st.line--;
      }
      return null;
    }
    if (data === "\x1b[3~") {
      // delete key
      if (st.col < line().length) setLine(line().slice(0, st.col) + line().slice(st.col + 1));
      else if (st.line < st.lines.length - 1) {
        st.lines[st.line] = line() + st.lines[st.line + 1]!;
        st.lines.splice(st.line + 1, 1);
      }
      return null;
    }
    if (data === "\x1b[C") {
      if (st.col < line().length) st.col++;
      else if (st.line < st.lines.length - 1) {
        st.line++;
        st.col = 0;
      }
      return null;
    }
    if (data === "\x1b[D") {
      if (st.col > 0) st.col--;
      else if (st.line > 0) {
        st.line--;
        st.col = st.lines[st.line]!.length;
      }
      return null;
    }
    if (data === "\x1b[A") {
      // Up recalls history when the cursor can't move up a line anyway
      // (opencode guard: cursor at offset 0 of the first line).
      if (st.lines.length === 1 && st.col === 0) {
        this.recallHistory(1);
      } else if (st.line > 0) {
        st.line--;
        st.col = Math.min(st.col, st.lines[st.line]!.length);
      }
      return null;
    }
    if (data === "\x1b[B") {
      // While browsing history, down walks forward; otherwise it moves lines.
      if (this.historyIndex !== -1 && st.lines.length === 1) {
        this.recallHistory(-1);
      } else if (st.line < st.lines.length - 1) {
        st.line++;
        st.col = Math.min(st.col, st.lines[st.line]!.length);
      }
      return null;
    }
    if (data === "\x1b[H" || data === "\x1b[1~" || data === "\x01") {
      st.col = 0;
      return null;
    }
    if (data === "\x1b[F" || data === "\x1b[4~" || data === "\x05") {
      st.col = line().length;
      return null;
    }
    if (data === "\x17") {
      // ctrl+w: delete word before cursor
      const cur = line();
      const left = cur.slice(0, st.col).replace(/\S*\s*$/, "");
      setLine(left + cur.slice(st.col));
      st.col = left.length;
      return null;
    }
    if (data === "\x15") {
      setLine(line().slice(st.col));
      st.col = 0;
      return null;
    }
    if (data === "\x0b") {
      setLine(line().slice(0, st.col));
      return null;
    }
    if (data === "\t") return "tab";
    if (data === "\x03") return "abort";
    if (data === "\x04") return this.isEmpty() ? "quit" : null;
    if (data === "\x1b") return "abort";
    // strip any other escape sequences we don't understand
    if (data.startsWith("\x1b") && data.length > 1) return null;
    if (data < " " && data !== "\n") return null;
    // printable (may be multi-char for IME/paste)
    const cur = line();
    setLine(cur.slice(0, st.col) + data + cur.slice(st.col));
    st.col += data.length;
    return null;
  }

  private recallHistory(dir: 1 | -1): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1 && dir === 1) {
      // Entering history: the current buffer is the draft to restore later.
      this.historyDraft = this.text;
      this.historyIndex = this.history.length;
    }
    const next = this.historyIndex + dir;
    if (next < 0 || next > this.history.length) return;
    if (next === this.history.length) {
      this.historyIndex = -1;
      this.reset(this.historyDraft);
      this.state.col = this.historyDraft.split("\n").slice(-1)[0]!.length;
      return;
    }
    this.historyIndex = next;
    this.reset(this.history[next]!);
    this.state.col = this.history[next]!.split("\n").slice(-1)[0]!.length;
  }

  pushHistory(text: string): void {
    if (text.trim() !== "" && this.history[this.history.length - 1] !== text) {
      this.history.push(text);
      if (this.history.length > 500) this.history.shift();
      this.onHistoryPush?.(text);
    }
  }
}

// ---------------------------------------------------------------------------
// The TUI
// ---------------------------------------------------------------------------

export async function runTuiSession(options: SessionOptions): Promise<void> {
  const { stdout, stdin } = process;
  const width = () => (stdout.columns && stdout.columns > 20 ? stdout.columns : 80);

  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?2004h"); // bracketed paste on
  // full-page home: wipe screen + scrollback so no shell history shows above
  // the banner, and home the cursor so bottom-region math starts from a known
  // position (terminals without \x1b[3J just keep their scrollback).
  stdout.write("\x1b[2J\x1b[3J\x1b[H");

  const editor = new RawEditor();
  editor.seedHistory(loadHistory());
  editor.onHistoryPush = (t) => appendHistory(t);
  const md = new LineBufferStreamer(styleMarkdownLine);
  const thinking = new LineBufferStreamer(styleThinkingLine);
  const decoder = new StringDecoder("utf8");

  let menuItems: { name: string; args?: string; description: string }[] = [];
  let menuIndex = 0;
  let fileMenu: { items: string[]; index: number; from: number } | null = null;
  let fileIndex: string[] | null = null;
  const pastes = new Map<string, string>();
  let pasteSeq = 0;
  // generic dialog picker (models, sessions, …): arrow keys + enter to pick
  let picker: {
    title: string;
    items: { label: string; detail?: string; mark?: "ok" | "fail" }[];
    index: number;
    onPick: (item: { label: string; detail?: string; mark?: "ok" | "fail"; value?: string }) => void | Promise<void>;
  } | null = null;
  // command palette (ctrl+p): fuzzy search over every command
  let palette: { all: PaletteItem[]; index: number; query: string } | null = null;
  let transientLines: string[] = []; // spinner/status lines rendered above the box
  let mode: "input" | "permission" | "exiting" = "input";
  let permissionResolve: ((ans: PermissionAnswer) => void) | null = null;
  // double-esc interrupt arming (opencode): first esc arms for 5s, second aborts
  let interruptArmedAt = 0;
  // toasts: transient notifications rendered above the input box
  let toasts: { text: string; kind: ToastKind; at: number }[] = [];
  let toastTimer: NodeJS.Timeout | null = null;
  let streaming = false;
  /** mode is mutated from nested callbacks; TS narrowing can't see it. */
  const isExiting = (): boolean => mode === "exiting";
  // unified busy spinner (waiting for model / tools running)
  let spinTimer: NodeJS.Timeout | null = null;
  let spinActive = false;
  let spinnerFrame = 0;
  let spinStartedAt = 0;
  const SPIN = ["✻", "✽", "✶", "✳"];
  const TOOL_SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  // whimsical per-turn verbs (claude-code convention)
  const SPIN_VERBS = [
    "Working", "Thinking", "Pondering", "Brewing", "Vibing", "Conjuring", "Simmering",
    "Noodling", "Percolating", "Hustling", "Polishing", "Cooking", "Ideating", "Mulling", "Crunching",
  ];
  const spinVerb = () => SPIN_VERBS[Math.floor(Math.random() * SPIN_VERBS.length)]!;
  let spinIsTool = false;
  let spinLabel = "";

  const controller = new SessionController(options, {
    print: (line) => printAbove(line),
    onEvent: handleAgentEvent,
    askPermission: askPermission,
    askPlanApproval: askPlanApproval,
    toast: (text, kind) => showToast(text, kind),
    onTitle: (title) => setWindowTitle(title),
  });
  initTheme(controller.themeSetting);

  /** shift+tab: cycle build → edit → plan. The persistent hint row above the
   * box is the feedback (no transcript spam). */
  function toggleMode(): void {
    controller.toggleMode();
    drawBottom(true);
  }

  // Background file index for @-completion (gitignore-aware, capped).
  void listFiles(options.cwd, { maxEntries: 3000 }).then(
    (files) => (fileIndex = files),
    () => (fileIndex = []),
  );

  // ----- bottom area drawing ----------------------------------------------

  const statusText = () => {
    const t = controller.totals;
    const w = width();
    const limit = controller.model.model.contextWindow;
    const usedPct = limit ? Math.min(100, Math.round((controller.contextTokens / limit) * 100)) : 0;
    // context fills green → yellow → red (claude-code-style gradation), shown
    // as remaining (opencode's "12% left" convention)
    const ctxCol = usedPct >= 85 ? fg.red : usedPct >= 60 ? fg.yellow : fg.green;
    const ctx = controller.contextTokens > 0 ? ` · ${ctxCol(`ctx ${Math.max(0, 100 - usedPct)}% left`)}` : "";
    const cost = t.cost > 0 ? ` · $${t.cost >= 0.01 ? t.cost.toFixed(2) : t.cost.toFixed(4)}` : "";
    const queue = controller.pendingCount > 0 ? ` · ⏎${controller.pendingCount}` : "";
    const todos = controller.todos;
    const tasks = todos.length > 0 ? ` · ${todos.filter((x) => x.status === "completed").length}/${todos.length} tasks` : "";
    const modeLabel = controller.mode === "plan" ? " · plan mode" : controller.mode === "edit" ? " · edit mode" : "";
    const flags = `${controller.policy === "yolo" ? " · yolo" : ""}${modeLabel}${tasks}${queue}`;
    // Narrow terminals drop weight progressively: tokens first, then dir.
    const tok = t.inputTokens + t.outputTokens > 0 ? ` · in ${fmtK(t.inputTokens)} out ${fmtK(t.outputTokens)}` : "";
    const core = ` ${controller.modelKey}${ctx}${cost}${flags} `;
    if (stringWidth(stripAnsi(core)) + 4 > w) return core; // already too long — clampWidth trims it
    const withDir = ` ${controller.modelKey} · ${shortCwd(options.cwd)}${ctx}${cost}${flags} `;
    return stringWidth(stripAnsi(withDir)) + 4 <= w ? withDir : core;
  };

  /** Persistent rows between the menus and the input box: active-mode hint
   * (claude-code keeps one visible while a mode is on) + empty-input hints. */
  function hintRows(): string[] {
    const w = width();
    const rows: string[] = [];
    if (controller.mode === "plan") rows.push(`  ${fg.magenta("⏸ plan mode on")} ${style.dim("(shift+tab to cycle)")}`);
    else if (controller.mode === "edit") rows.push(`  ${fg.cyan("⏵⏵ accept edits on")} ${style.dim("(shift+tab to cycle)")}`);
    else if (controller.policy === "yolo") rows.push(`  ${fg.yellow("⏵⏵ yolo on")} ${style.dim("(permission prompts off · /yolo to re-enable)")}`);
    const limit = controller.model.model.contextWindow;
    const pct = limit ? Math.min(100, Math.round((controller.contextTokens / limit) * 100)) : 0;
    if (pct >= 85) rows.push(style.dim("  ⚠ context nearly full — /compact to free space"));
    if (interruptArmedAt > 0 && Date.now() - interruptArmedAt < 5000) {
      rows.push(`  ${fg.yellow("esc again to interrupt")}`);
    }
    if (menuItems.length === 0 && !fileMenu && !picker && !palette && editor.isEmpty() && mode === "input" && !controller.busy) {
      rows.push(style.dim("  ? shortcuts · ctrl+p palette · ! bash · # memory · / commands · @ files"));
    }
    // Every row must fit the terminal or the region row accounting breaks.
    return rows.map((r) => clampWidth(r, w - 2));
  }

  // ----- toasts (transient notifications; opencode ui/toast.tsx, simplified) --

  function showToast(text: string, kind: ToastKind = "info"): void {
    toasts.push({ text, kind, at: Date.now() });
    if (toasts.length > 3) toasts = toasts.slice(-3);
    scheduleToastExpiry();
    drawBottom(true);
  }

  function scheduleToastExpiry(): void {
    if (toastTimer) return;
    toastTimer = setInterval(() => {
      const before = toasts.length;
      toasts = toasts.filter((t) => Date.now() - t.at < 5000);
      if (toasts.length === 0) {
        clearInterval(toastTimer!);
        toastTimer = null;
      }
      if (toasts.length !== before) drawBottom(true);
    }, 1000);
  }

  function renderToasts(): string[] {
    toasts = toasts.filter((t) => Date.now() - t.at < 5000);
    if (toasts.length === 0) return [];
    const t = toasts[toasts.length - 1]!;
    const color = t.kind === "error" ? fg.red : t.kind === "success" ? fg.green : t.kind === "warning" ? fg.yellow : fg.cyan;
    const glyph = t.kind === "error" ? "✗" : t.kind === "success" ? "✓" : t.kind === "warning" ? "⚠" : "·";
    const more = toasts.length > 1 ? style.dim(` (+${toasts.length - 1})`) : "";
    return [clampWidth(` ${color(glyph)} ${t.text}${more}`, width() - 4)];
  }

  function setWindowTitle(title: string): void {
    stdout.write(`\x1b]0;wcode · ${title}\x07`);
  }

  // Cursor anchor tracking (the invariant every draw maintains):
  // after drawBottom, the cursor sits at the edit position inside the input
  // box. cursorRowInRegion = rows below the region's top row where the cursor
  // rests — captured at draw time so clears use the OLD position even when
  // the editor state has since changed.
  let bottomRows = 0;
  let cursorRowInRegion = 0;

  /** Escape prefix that erases the previous bottom region from wherever the
   * cursor currently rests. Returned as a string instead of written directly:
   * the clear must land in the SAME write as the redrawn content, or the
   * terminal paints the erased region in between — that gap is the flicker. */
  function regionClearPrefix(): string {
    if (bottomRows === 0) return "";
    return `${cursorRowInRegion > 0 ? `\x1b[${cursorRowInRegion}A` : ""}\r\x1b[J`;
  }

  /** Visible window of `line` around the cursor for horizontal overflow. */
  function visibleSlice(line: string, col: number, available: number): { text: string; colOffset: number } {
    if (stringWidth(line) <= available) return { text: line, colOffset: 0 };
    // keep a window ending at the cursor when possible
    const before = line.slice(0, col);
    let start = 0;
    while (stringWidth(before.slice(start)) > available - 1 && start < before.length) start++;
    let end = line.length;
    while (stringWidth(line.slice(start, end)) > available - 1 && end > start) end--;
    const text = (start > 0 ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : "");
    return { text, colOffset: start };
  }

  /** Build the bottom region rows plus the reposition suffix that parks the
   * cursor at the edit position. Mutates the bottomRows/cursorRowInRegion
   * anchors; callers capture regionClearPrefix() BEFORE calling this. */
  function buildBottomRegion(): { body: string; reposition: string } {
    const w = width();
    const lines: string[] = [];
    const topRows = [
      ...(palette ? renderPalette(w) : picker ? renderPicker(w) : fileMenu ? renderFileMenu(w) : renderMenu(w)),
      ...hintRows(),
      ...renderToasts(),
    ];
    for (const hint of topRows) lines.push(hint);
    lines.push(...transientLines);
    lines.push(fg.cyan(`╭─${style.bold(" wcode ")}${"─".repeat(Math.max(2, w - 12))}╮`));
    const inputLines = editor.state.lines;
    const available = w - 6;
    inputLines.forEach((l, i) => {
      const prefix = i === editor.state.line ? fg.cyan("> ") : "  ";
      let content = l;
      let col = editor.state.col;
      if (i === editor.state.line) {
        const win = visibleSlice(l, col, available);
        content = win.text;
        col = col - win.colOffset;
        // pad to full width so the border stays put
        const pad = Math.max(0, available - stringWidth(content));
        content = content + " ".repeat(pad);
      } else {
        content = truncate(l, available);
      }
      lines.push(`${fg.cyan("│")} ${prefix}${content} ${fg.cyan("│")}`);
    });
    // The status row must never exceed the terminal width — a wrapped row
    // breaks the region row accounting and corrupts the next redraw.
    const status = clampWidth(statusText(), Math.max(8, w - 8));
    const statusWidth = stringWidth(stripAnsi(status));
    const bottomFill = Math.max(2, w - 4 - statusWidth);
    lines.push(`${fg.cyan("╰─")}${style.dim(status)}${fg.cyan("─".repeat(bottomFill) + "╯")}`);
    bottomRows = lines.length;
    // reposition: cursor rests on the bottom-border row after the write; the
    // input row is exactly (inputLines.length - line) rows above it.
    const up = inputLines.length - editor.state.line;
    const visibleBefore = visibleSlice(
      editor.state.lines[editor.state.line]!,
      editor.state.col,
      available,
    );
    const cursorCol = 4 + stringWidth(visibleBefore.text.slice(0, editor.state.col - visibleBefore.colOffset));
    const reposition = `\x1b[${up}A\r\x1b[${Math.min(cursorCol, w - 3)}C`;
    cursorRowInRegion = topRows.length + transientLines.length + 1 + editor.state.line;
    return { body: lines.join("\r\n") + "\r", reposition };
  }

  function drawBottom(clearFirst: boolean): void {
    // One synchronized write: the erase and the redraw must land in the same
    // chunk — flicker only appears between writes.
    const clear = clearFirst ? regionClearPrefix() : "";
    const { body, reposition } = buildBottomRegion();
    stdout.write(SYNC_BEGIN + CURSOR_HIDE + clear + body + reposition + CURSOR_SHOW + SYNC_END);
  }

  function printAbove(text: string): void {
    const clear = regionClearPrefix();
    const { body, reposition } = buildBottomRegion();
    stdout.write(
      SYNC_BEGIN + CURSOR_HIDE + clear + text.replace(/\n/g, "\r\n") + "\r\n" + body + reposition + CURSOR_SHOW + SYNC_END,
    );
  }

  // ----- busy spinner (Claude-Code-style loading animation) ----------------

  function spinElapsed(): string {
    const s = Math.max(0, Math.round((Date.now() - spinStartedAt) / 1000));
    const t = controller.totals;
    const tok = t.inputTokens + t.outputTokens > 0 ? ` · ${fmtK(t.inputTokens + t.outputTokens)} tok` : "";
    return `(${s}s · esc to interrupt${tok})`;
  }

  function renderSpin(): void {
    const w = width();
    if (spinIsTool) {
      const frame = TOOL_SPIN[spinnerFrame % TOOL_SPIN.length]!;
      const label = spinLabel !== "" ? `${truncate(spinLabel, w - 10)} ` : "";
      transientLines = [`  ${fg.cyan(frame)} ${label}${style.dim(spinElapsed())}`];
    } else {
      const frame = SPIN[spinnerFrame % SPIN.length]!;
      transientLines = [`  ${fg.magenta(frame)} ${style.bold(truncate(spinLabel, w - 20))} ${style.dim(spinElapsed())}`];
    }
  }

  function startSpin(label: string, isTool = false): void {
    spinLabel = label;
    spinIsTool = isTool;
    spinStartedAt = Date.now();
    if (!spinActive) {
      spinActive = true;
      spinnerFrame = 0;
      scheduleSpin();
    }
    renderSpin();
    drawBottom(true);
  }

  function scheduleSpin(): void {
    // glyph cycle is intentionally slow (Claude-Code-like); braille a bit snappier
    spinTimer = setTimeout(() => {
      if (!spinActive) return;
      spinnerFrame++;
      renderSpin();
      drawBottom(true);
      scheduleSpin();
    }, spinIsTool ? 130 : 220);
  }

  function stopSpin(): void {
    spinActive = false;
    if (spinTimer) {
      clearTimeout(spinTimer);
      spinTimer = null;
    }
    transientLines = [];
  }

  // ----- agent event rendering --------------------------------------------

  let thinkingStartedAt = 0;
  let thinkingChars = 0;

  function handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        stopSpin();
        // thinking finishes before text starts; flush its tail in order
        if (thinking.hasBuffer()) thinking.flush((line) => printAbove(line));
        md.feed(event.delta, (line) => printAbove(line));
        break;
      case "thinking_delta":
        stopSpin();
        if (thinkingStartedAt === 0) {
          thinkingStartedAt = Date.now();
          thinkingChars = 0;
        }
        thinkingChars += event.delta.length;
        thinking.feed(event.delta, (line) => printAbove(line));
        break;
      case "tool_start":
        stopSpin();
        // the action card prints immediately; the spinner runs beneath it
        // until the result replaces it (claude-code's ⏺ / ⎿ layout)
        printAbove(
          `  ${fg.green("⏺")} ${style.bold(event.call.name)}${event.summary ? style.dim(`(${truncate(event.summary, width() - 12)})`) : ""}`,
        );
        startSpin("", true);
        break;
      case "tool_update":
        spinLabel = event.line;
        break;
      case "tool_end": {
        stopSpin();
        const lines = [
          event.isError
            ? `  ${fg.red("⎿")} ${fg.red(event.output.display || "failed")}`
            : `  ${style.dim("⎿")} ${style.dim(event.output.display || "(no output)")}`,
        ];
        if (event.output.detail) {
          const detailLines = event.output.detail.split("\n");
          for (const l of colorizeDiffLines(detailLines.slice(0, 20))) lines.push(l);
          if (detailLines.length > 20) lines.push(style.dim("    …"));
        }
        printAbove(lines.join("\r\n"));
        break;
      }
      case "message_end":
        stopSpin();
        thinking.flush((line) => printAbove(line));
        md.flush((line) => printAbove(line));
        if (thinkingChars > 0 && thinkingStartedAt > 0) {
          printAbove(style.dim(`· thought for ${((Date.now() - thinkingStartedAt) / 1000).toFixed(1)}s`));
        }
        thinkingStartedAt = 0;
        thinkingChars = 0;
        printAbove("");
        break;
      case "notice":
        // Transient churn goes to the toast corner; structural events stay in
        // the transcript where they can be read back.
        if (/^retrying|context prune|context overflow/.test(event.message)) showToast(event.message, "info");
        else printAbove(style.dim(`─ ${event.message} ─`));
        break;
      case "turn_end": {
        stopSpin();
        interruptArmedAt = 0;
        const u = event.totalUsage;
        printAbove(style.dim(`─ in ${fmtK(u.inputTokens)}, out ${fmtK(u.outputTokens)} ─`));
        if (event.changes && event.changes.length > 0) {
          const shown = event.changes.slice(0, 4).map((c) => `${c.path} ${fg.green(`+${c.added}`)} ${fg.red(`-${c.removed}`)}`);
          const more = event.changes.length > 4 ? style.dim(` +${event.changes.length - 4} more`) : "";
          printAbove(`─ ${style.bold(`Changed ${event.changes.length} file${event.changes.length === 1 ? "" : "s"}`)}: ${shown.join(", ")}${more} ─`);
        }
        break;
      }
      case "error":
        stopSpin();
        printAbove(fg.red(`error: ${event.errorMessage}`));
        break;
    }
  }

  /** Colorize unified-diff lines (+ green / − red), dim everything else. */
  function colorizeDiffLines(lines: string[], indent = "    "): string[] {
    return lines.map((l) => {
      if (l.startsWith("+")) return fg.green(indent + l);
      if (l.startsWith("-")) return fg.red(indent + l);
      if (l.startsWith("@@")) return fg.cyan(indent + l);
      return style.dim(indent + l);
    });
  }

  // ----- permission prompts -------------------------------------------------

  /** Shared y/n/a prompt: takes over the bottom area until answered. */
  function promptAnswer(lines: string[], denyLine: string | null): Promise<PermissionAnswer> {
    return new Promise((resolve) => {
      mode = "permission";
      permissionResolve = (ans) => {
        if (ans === "no" && denyLine !== null) printAbove(denyLine);
        resolve(ans);
      };
      stopSpin();
      // clear must use cursorRowInRegion (the cursor rests at the edit row
      // inside the region, not below it) and ride in the same write as the
      // prompt — overshooting would erase transcript rows above the box.
      const clear = regionClearPrefix();
      transientLines = [];
      bottomRows = 0;
      cursorRowInRegion = 0;
      stdout.write(SYNC_BEGIN + CURSOR_HIDE + clear + lines.join("\r\n") + "\r\n" + CURSOR_SHOW + SYNC_END);
    });
  }

  function askPermission(req: ToolPermissionRequest): Promise<PermissionAnswer> {
    const detail = req.detail
      ? colorizeDiffLines(req.detail.split("\n").slice(0, 16), "").join("\r\n")
      : "";
    return promptAnswer(
      [
        `${fg.yellow(`● ${req.tool}`)} ${req.summary.length > 100 ? req.summary.slice(0, 100) + "…" : req.summary}`,
        detail,
        `${fg.yellow("allow this action?")} ${style.dim("[y] yes · [a] always allow · [n] no (esc)")}`,
      ].filter((s) => s !== ""),
      style.dim("denied"),
    );
  }

  /** Answer the active prompt (permission or plan approval). */
  function answerPrompt(ans: PermissionAnswer): void {
    const resolve = permissionResolve;
    permissionResolve = null;
    mode = "input";
    resolve?.(ans);
  }

  /** Plan approval (exit_plan): yes switches to build mode and implements. */
  async function askPlanApproval(req: { plan: string; planFile: string }): Promise<boolean> {
    const allLines = req.plan.split("\n");
    const head = allLines.slice(0, 14).map((l) => style.dim(`  │ ${l}`));
    if (allLines.length > 14) head.push(style.dim("  │ …"));
    const ans = await promptAnswer(
      [
        `${fg.magenta("⏸ plan ready for review")} ${style.dim(`· ${req.planFile}`)}`,
        ...head,
        `${fg.magenta("approve this plan?")} ${style.dim("[y] start implementing · [n] keep planning")}`,
      ],
      style.dim("plan kept — still in plan mode"),
    );
    return ans !== "no";
  }

  // ----- raw key handling --------------------------------------------------
  // KeyStream (ported from opentui's parser) assembles escape sequences that
  // arrive split across reads, disambiguates lone ESC, and folds bracketed
  // paste into verbatim chunks. Parsed keys are mapped to the legacy single-
  // key strings handleChunk understands.

  const keyStream = new KeyStream(
    (key) => {
      if (key.name === "tab" && key.shift) {
        // shift+tab cycles modes; ignored mid-prompt (permission/plan dialogs own the keys).
        if (mode === "input") toggleMode();
        return;
      }
      // ctrl+p: command palette
      if (key.ctrl && !key.meta && key.name === "p") {
        if (mode === "input") openPalette();
        return;
      }
      // ctrl+o: compose the current input in $EDITOR
      if (key.ctrl && !key.meta && key.name === "o") {
        if (mode === "input" && !palette) void openExternalEditor();
        return;
      }
      // alt+enter: queue the message instead of steering
      if (key.name === "return" && key.meta) {
        if (mode === "input" && !palette && !picker) void submit("queue");
        return;
      }
      if (key.char !== "" && key.name === "") {
        handleChunk(key.char);
        return;
      }
      let legacy: string;
      switch (key.name) {
        case "up": legacy = "\x1b[A"; break;
        case "down": legacy = "\x1b[B"; break;
        case "left": legacy = "\x1b[C"; break;
        case "right": legacy = "\x1b[D"; break;
        case "home": legacy = "\x1b[H"; break;
        case "end": legacy = "\x1b[F"; break;
        case "delete": legacy = "\x1b[3~"; break;
        case "return": legacy = "\r"; break;
        case "linefeed": legacy = "\n"; break;
        case "tab": legacy = "\t"; break;
        case "backspace": legacy = "\x7f"; break;
        case "escape": legacy = "\x1b"; break;
        default:
          if (key.ctrl && key.name.length === 1) {
            legacy = String.fromCharCode(key.name.charCodeAt(0) - 96);
          } else if (key.meta && key.char !== "") {
            handleChunk("\x1b" + key.char);
            return;
          } else {
            return; // unhandled named key (f-keys, pageup, ...)
          }
      }
      handleChunk(legacy);
    },
    (text) => insertPaste(text),
  );

  stdin.on("data", (buf: Buffer) => {
    const data = decoder.write(buf);
    if (data !== "") keyStream.feed(data);
  });

  function insertPaste(text: string): void {
    if (mode !== "input") return;
    let cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lineCount = cleaned.split("\n").length;
    if (lineCount > 3 || cleaned.length > 150) {
      // opencode-style fold: placeholder in the box, full text expanded on send
      const id = ++pasteSeq;
      pastes.set(String(id), cleaned);
      cleaned = `[Pasted ~${lineCount} lines #${id}]`;
    }
    const st = editor.state;
    const cur = st.lines[st.line]!;
    const left = cur.slice(0, st.col);
    const right = cur.slice(st.col);
    if (cleaned.includes("\n")) {
      // multi-line paste: left + first line, middle lines, last + right
      const parts = cleaned.split("\n");
      const newLines = [left + parts[0]!, ...parts.slice(1)];
      newLines[newLines.length - 1] = newLines[newLines.length - 1]! + right;
      st.lines.splice(st.line, 1, ...newLines);
      st.line += newLines.length - 1;
      st.col = st.lines[st.line]!.length - right.length;
    } else {
      st.lines[st.line] = left + cleaned + right;
      st.col += cleaned.length;
    }
    updateHints();
    drawBottom(true);
  }

  function handleChunk(data: string): void {
    // Split into discrete keys: escape sequences stay atomic.
    const keys = data.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b[0-9A-Za-z]|\r|\n|\x7f|\t|\x03|\x04|\x01|\x05|\x0b|\x0c|\x15|\x17|[\s\S]/g) ?? [];
    for (const key of keys) {
      if (mode === "permission") {
        if (key === "y" || key === "Y" || key === "\r" || key === "1") answerPrompt("yes");
        else if (key === "a" || key === "A" || key === "2") answerPrompt("always");
        else if (key === "n" || key === "N" || key === "\x1b" || key === "\x03" || key === "3") answerPrompt("no");
        continue;
      }
      // Command palette captures all keys while open.
      if (palette) {
        const n = paletteFiltered().length;
        if (key === "\x1b[A") {
          if (n > 0) palette.index = (palette.index - 1 + n) % n;
          drawBottom(true);
        } else if (key === "\x1b[B") {
          if (n > 0) palette.index = (palette.index + 1) % n;
          drawBottom(true);
        } else if (key === "\r") {
          void runPaletteSelection();
        } else if (key === "\x1b" || key === "\x03" || key === "\x04") {
          palette = null;
          drawBottom(true);
        } else if (key === "\x7f") {
          palette.query = palette.query.slice(0, -1);
          palette.index = 0;
          drawBottom(true);
        } else if (key.length === 1 && key >= " ") {
          palette.query += key;
          palette.index = 0;
          drawBottom(true);
        }
        continue;
      }

      // Dialog picker (models, sessions) captures all keys while open.
      if (picker) {
        const n = picker.items.length;
        if (key === "\x1b[A") {
          picker.index = (picker.index - 1 + n) % n;
          drawBottom(true);
        } else if (key === "\x1b[B") {
          picker.index = (picker.index + 1) % n;
          drawBottom(true);
        } else if (key === "\r") {
          const chosen = picker.items[picker.index]!;
          const onPick = picker.onPick;
          picker = null;
          void onPick(chosen);
          drawBottom(true);
        } else if (key === "\x1b" || key === "\x03" || key === "\x04") {
          picker = null;
          drawBottom(true);
        }
        continue;
      }

      if (key === "\x03") {
        if (controller.busy) {
          controller.abort();
          printAbove(style.dim("· interrupted ·"));
          continue;
        }
        if (editor.isEmpty()) {
          mode = "exiting";
          quit();
          return;
        }
        editor.reset();
        updateHints();
        drawBottom(true);
        continue;
      }
      if (key === "\x0c") {
        // ctrl+l: clear the screen, conversation stays (banner redraws as home)
        stdout.write("\x1b[2J\x1b[3J\x1b[H");
        printAbove(banner);
        if (controller.resumeNotice !== "") printAbove(style.dim(controller.resumeNotice));
        drawBottom(true);
        continue;
      }
      if (key === "?" && mode === "input" && !controller.busy && editor.isEmpty() && menuItems.length === 0 && !fileMenu) {
        // claude-code convention: "?" on empty input opens the shortcuts panel
        printAbove(renderShortcuts());
        drawBottom(true);
        continue;
      }
      // @file menu navigation takes precedence over everything below.
      if (fileMenu) {
        const n = fileMenu.items.length;
        if (key === "\x1b[A") {
          fileMenu.index = (fileMenu.index - 1 + n) % n;
          drawBottom(true);
          continue;
        }
        if (key === "\x1b[B") {
          fileMenu.index = (fileMenu.index + 1) % n;
          drawBottom(true);
          continue;
        }
        if (key === "\t" || key === "\r" || key === "\n") {
          insertFileSelection();
          continue;
        }
        if (key === "\x1b") {
          fileMenu = null;
          drawBottom(true);
          continue;
        }
      }

      // Slash menu navigation takes precedence over editor key handling
      // (including the bare-Esc ignore below).
      if (menuItems.length > 0 && (key === "\x1b[A" || key === "\x1b[B")) {
        menuIndex = (menuIndex + (key === "\x1b[A" ? -1 : 1) + menuItems.length) % menuItems.length;
        drawBottom(true);
        continue;
      }
      if (menuItems.length > 0 && key === "\x1b") {
        menuItems = []; // dismiss menu, keep typed text
        drawBottom(true);
        continue;
      }
      if (key === "\x1b" && !streaming && mode === "input" && !controller.busy) {
        // bare escape with no busy work: ignore (avoids clobbering input)
        interruptArmedAt = 0;
        continue;
      }
      if (key === "\x1b" && controller.busy) {
        // double-press interrupt (opencode): the first esc arms for 5s so a
        // stray escape doesn't kill a long-running turn mid-flight.
        const now = Date.now();
        if (interruptArmedAt > 0 && now - interruptArmedAt < 5000) {
          interruptArmedAt = 0;
          controller.abort();
          printAbove(style.dim("· interrupted ·"));
        } else {
          interruptArmedAt = now;
          drawBottom(true); // hint row: "esc again to interrupt"
        }
        continue;
      }
      if (mode !== "input") continue;

      const action = editor.handleKey(key);
      if (action === "submit") {
        void submit();
      } else if (action === "tab") {
        if (menuItems.length > 0) {
          editor.reset(`/${menuItems[menuIndex]!.name} `);
          updateHints();
        }
        drawBottom(true);
      } else if (action === "abort" || action === "quit") {
        if (action === "quit") {
          mode = "exiting";
          quit();
          return;
        }
      } else {
        updateHints();
        drawBottom(true);
      }
    }
  }

  function renderFileMenu(w: number): string[] {
    const rows = [style.dim("  file · ↑↓ move · tab/enter insert · esc dismiss")];
    fileMenu!.items.forEach((f, i) => {
      if (i === fileMenu!.index) rows.push(`  ${style.bold(fg.cyan(`❯ @${f}`))}`.slice(0, w - 2));
      else rows.push(style.dim(`    @${f}`).slice(0, w - 2));
    });
    return rows;
  }

  function renderMenu(w: number): string[] {
    return menuItems.slice(0, 9).map((c, i) => {
      const label = `/${c.name}${c.args ? " " + c.args : ""}`;
      const desc = c.description;
      const gap = Math.max(1, 26 - label.length);
      if (i === menuIndex) {
        return clampWidth(`  ${style.bold(fg.cyan(`❯ ${label}`))}${" ".repeat(gap)}${desc}`, w - 2);
      }
      return clampWidth(style.dim(`    ${label}${" ".repeat(gap)}${desc}`), w - 2);
    });
  }

  /** Generic dialog picker with a 9-row sliding window (tall dialogs would
   * overflow short terminals and break the region row accounting). */
  function renderPicker(w: number): string[] {
    const items = picker!.items;
    const rows = [style.dim(`  ${picker!.title} · ↑↓ move · enter select · esc cancel`)];
    const start = Math.max(0, Math.min(picker!.index - 4, items.length - 9));
    items.slice(start, start + 9).forEach((item, i) => {
      const realIndex = start + i;
      const mark = item.mark === "ok" ? fg.green("✓") : item.mark === "fail" ? fg.red("✗") : " ";
      const label = `${mark} ${item.label}${item.detail ? style.dim(`  ${item.detail}`) : ""}`;
      if (realIndex === picker!.index) {
        rows.push(clampWidth(`  ${style.bold(fg.cyan(`❯ ${label}`))}`, w - 2));
      } else {
        rows.push(clampWidth(style.dim(`    ${label}`), w - 2));
      }
    });
    if (items.length > 9) rows.push(style.dim(`  ${picker!.index + 1}/${items.length}`));
    return rows;
  }

  function renderPalette(w: number): string[] {
    const items = paletteFiltered();
    const queryNote = palette!.query === "" ? "type to filter" : `filter: ${palette!.query}`;
    const rows = [style.dim(`  command palette · ${queryNote} · ↑↓ move · enter run · esc close`)];
    if (items.length === 0) {
      rows.push(style.dim("    (no matching commands)"));
      return rows;
    }
    const start = Math.max(0, Math.min(palette!.index - 4, items.length - 9));
    items.slice(start, start + 9).forEach((item, i) => {
      const realIndex = start + i;
      const label = `/${item.name}  ${item.description}`;
      if (realIndex === palette!.index) {
        rows.push(clampWidth(`  ${style.bold(fg.cyan(`❯ ${label}`))}`, w - 2));
      } else {
        rows.push(clampWidth(style.dim(`    ${label}`), w - 2));
      }
    });
    if (items.length > 9) rows.push(style.dim(`  ${palette!.index + 1}/${items.length}`));
    return rows;
  }

  /** The "?" shortcuts panel (claude-code opens one on "?" with empty input). */
  function renderShortcuts(): string {
    const w = width();
    const rows = [style.bold("keyboard shortcuts")];
    for (const [key, desc] of SHORTCUTS) rows.push(clampWidth(`  ${style.dim(key.padEnd(16))}${desc}`, w - 2));
    return rows.join("\n");
  }

  function openPicker(): void {
    const items = controller.configuredModels();
    if (items.length === 0) {
      printAbove(style.dim("no models configured. See /help or wcode help."));
      return;
    }
    menuItems = [];
    fileMenu = null;
    picker = {
      title: "select model",
      items: items.map((entry) => ({
        label: `${entry.key} · ${entry.provider.api}`,
        mark: entry.available ? ("ok" as const) : ("fail" as const),
        value: entry.key,
      })),
      index: Math.max(0, items.findIndex((e) => e.key === controller.modelKey)),
      onPick: (item) => {
        printAbove(`${style.bold(fg.magenta("> /models"))}`);
        printAbove(controller.switchModel(item.value!));
      },
    };
    drawBottom(true);
  }

  /** Interactive session list (opencode dialog-session-list, trimmed). */
  function openSessionPicker(): void {
    const sessions = listSessions();
    if (sessions.length === 0) {
      printAbove(style.dim("no saved sessions"));
      return;
    }
    menuItems = [];
    fileMenu = null;
    picker = {
      title: "resume session",
      items: sessions.slice(0, 12).map((s) => ({
        label: truncate(s.title ?? (s.preview || "(empty)"), 48),
        detail: `${s.createdAt.slice(0, 16).replace("T", " ")} · ${s.model} · ${s.messageCount} msgs`,
        value: s.file,
      })),
      index: 0,
      onPick: (item) => {
        printAbove(`${style.bold(fg.magenta("> /sessions"))}`);
        const summary = sessions.find((s) => s.file === item.value);
        if (summary) printAbove(controller.resumeSession(summary));
      },
    };
    drawBottom(true);
  }

  /** /theme with no args: interactive theme picker (keyboard-driven). */
  function openThemePicker(): void {
    const themes = listThemes();
    menuItems = [];
    fileMenu = null;
    picker = {
      title: "select theme",
      items: themes.map((t) => ({
        label: t.name,
        detail: t.description,
        mark: t.name === activeThemeName() ? ("ok" as const) : undefined,
        value: t.name,
      })),
      index: Math.max(0, themes.findIndex((t) => t.name === activeThemeName())),
      onPick: (item) => {
        printAbove(controller.switchTheme(item.value!));
      },
    };
    drawBottom(true);
  }

  // ----- command palette (ctrl+p) --------------------------------------------

  function paletteFiltered(): PaletteItem[] {
    return fuzzyFilter(palette!.all, palette!.query, (item) => `${item.name} ${item.description}`);
  }

  function openPalette(): void {
    const all = buildPaletteItems();
    if (all.length === 0) return;
    menuItems = [];
    fileMenu = null;
    picker = null;
    palette = { all, index: 0, query: "" };
    drawBottom(true);
  }

  function buildPaletteItems(): PaletteItem[] {
    const items: PaletteItem[] = [];
    const run = (name: string): (() => void) => () => void runLine(`/${name}`);
    for (const cmd of SLASH_COMMANDS) {
      items.push({
        name: cmd.name,
        description: cmd.description,
        run:
          cmd.name === "models"
            ? openPicker
            : cmd.name === "sessions" || cmd.name === "resume"
              ? openSessionPicker
              : cmd.name === "theme"
                ? openThemePicker
                : run(cmd.name),
      });
    }
    for (const cmd of loadCustomCommands(controller.cwd)) {
      items.push({ name: cmd.name, description: cmd.description, run: () => void runLine(`/${cmd.name}`) });
    }
    items.push({
      name: "quit",
      description: "exit wcode (also: ctrl+d)",
      run: () => {
        mode = "exiting";
        quit();
      },
    });
    return items;
  }

  async function runPaletteSelection(): Promise<void> {
    const item = paletteFiltered()[palette!.index];
    if (!item) return;
    palette = null;
    await item.run();
    drawBottom(true);
  }

  /** ctrl+o: edit the current input in $VISUAL/$EDITOR (opencode <leader>e). */
  async function openExternalEditor(): Promise<void> {
    const editorBin = process.env.VISUAL || process.env.EDITOR;
    if (!editorBin) {
      showToast("no $EDITOR or $VISUAL set", "warning");
      return;
    }
    const file = join(tmpdir(), `wcode-editor-${process.pid}-${Date.now()}.md`);
    try {
      writeFileSync(file, editor.text, "utf8");
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(CURSOR_SHOW);
      const res = spawnSync(editorBin, [file], { stdio: "inherit" });
      if (res.error) throw res.error;
      if (res.status === 0) {
        const content = readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
        if (content.trim() !== "") editor.reset(content);
      } else {
        showToast(`${editorBin} exited with code ${res.status}`, "warning");
      }
    } catch (err) {
      showToast(`editor failed: ${(err as Error).message}`, "error");
    } finally {
      rmSync(file, { force: true });
      stdin.setRawMode(true);
      stdin.resume();
      updateHints();
      drawBottom(true);
    }
  }

  function insertFileSelection(): void {
    const st = editor.state;
    const line = st.lines[st.line]!;
    const chosen = fileMenu!.items[fileMenu!.index]!;
    st.lines[st.line] = line.slice(0, fileMenu!.from) + chosen + " " + line.slice(st.col);
    st.col = fileMenu!.from + chosen.length + 1;
    fileMenu = null;
    updateHints();
    drawBottom(true);
  }

  function updateHints(): void {
    const items = controller.slashCommands(editor.text).slice(0, 9);
    if (items.length === 0) {
      menuItems = [];
      menuIndex = 0;
    } else {
      // keep the selection stable when the list merely narrows
      if (menuIndex >= items.length) menuIndex = items.length - 1;
      menuItems = items;
      fileMenu = null;
      return;
    }
    // @file completion: "@partial" token ending at the cursor on this line
    const lineText = editor.state.lines[editor.state.line]!.slice(0, editor.state.col);
    const m = lineText.match(/@([^\s@]*)$/);
    if (!m || fileIndex === null || fileIndex.length === 0) {
      fileMenu = null;
      return;
    }
    const partial = m[1]!.toLowerCase();
    const from = editor.state.col - m[0].length;
    const matches = fileIndex.filter((f) => f.toLowerCase().includes(partial)).slice(0, 9);
    fileMenu = matches.length > 0 ? { items: matches, index: 0, from } : null;
  }

  function expandPastes(text: string): string {
    return text.replace(/\[Pasted ~\d+ lines? #(\d+)\]/g, (m, id) => pastes.get(id as string) ?? m);
  }

  let running = false;
  async function submit(deliver: "steer" | "queue" = "steer"): Promise<void> {
    // Enter with the slash menu open executes the highlighted command: expand
    // the box to the resolved command first, so picker interception in runLine
    // also covers menu execution (typing "/mo" + enter must open the picker).
    if (menuItems.length > 0) {
      editor.reset(`/${menuItems[menuIndex]!.name}`);
      menuItems = [];
      menuIndex = 0;
    }
    let text = editor.text.replace(/\\\n$/s, "\n").trim();
    if (text === "") {
      drawBottom(true);
      return;
    }
    text = expandPastes(text);
    editor.reset();
    updateHints();
    await runLine(text, deliver);
  }

  /** Run one submitted line: echo it, work (or steer/queue while busy), then
   * drain the queue. Shared by Enter, alt+enter, the palette and pickers. */
  async function runLine(text: string, deliver: "steer" | "queue" = "steer"): Promise<void> {
    // Interactive pickers open instead of printing lists (TUI-only views).
    const trimmed = text.trim();
    if (trimmed === "/models" || trimmed === "/sessions" || trimmed === "/resume" || trimmed === "/theme") {
      printAbove(`${style.bold(fg.magenta("> " + trimmed))}`);
      if (trimmed === "/models") openPicker();
      else if (trimmed === "/theme") openThemePicker();
      else openSessionPicker();
      return;
    }
    if (running || controller.busy) {
      // opencode inbox: plain text steers into the running prompt at the next
      // turn boundary; commands and alt+enter wait in the post-run queue.
      const how = controller.submitWhileBusy(text, deliver);
      printAbove(style.dim(how === "steered" ? `⏎ steer: ${truncate(text, 60)}` : `⏎ queued: ${truncate(text, 60)}`));
      drawBottom(true);
      return;
    }
    editor.pushHistory(text);
    printAbove(`${style.bold(fg.magenta("> " + (text.length > 400 ? text.slice(0, 400) + "…" : text)))}`);
    startSpin(`${spinVerb()}…`);
    running = true;
    streaming = true;
    try {
      const outcome = await controller.handleLine(text);
      if (outcome.kind === "prompt") await controller.runPrompt(outcome.promptText ?? text);
      else if (outcome.kind === "exit") {
        mode = "exiting";
        quit();
        return;
      }
    } catch (err) {
      printAbove(fg.red(`error: ${(err as Error).message}`));
    } finally {
      running = false;
      streaming = false;
      stopSpin();
    }
    if (isExiting()) return;
    // Drain the post-run queue (queued prompts + steers that missed the run).
    for (const p of controller.drainPending()) {
      if (isExiting()) break;
      await runLine(p);
    }
    drawBottom(true);
  }

  // ----- lifecycle ---------------------------------------------------------

  const cleanup = () => {
    if (spinTimer) clearTimeout(spinTimer);
    if (toastTimer) clearInterval(toastTimer);
    stdout.write("\x1b[?2004l"); // bracketed paste off
    stdout.write(CURSOR_SHOW);
    stdin.setRawMode(false);
    stdin.pause();
  };

  const onResize = () => {
    banner = buildBanner(); // the next ctrl+l prints the fresh-width banner
    drawBottom(true);
  };
  stdout.on("resize", onResize);

  function quit(): void {
    cleanup();
    stdout.removeListener("resize", onResize);
    controller.shutdown(); // kill MCP children so they don't orphan
    printAbove(style.dim("bye"));
    process.exit(0);
  }

  const onSigint = () => {
    if (controller.busy) controller.abort();
    else {
      mode = "exiting";
      quit();
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", () => {
    mode = "exiting";
    quit();
  });

  // banner: block-letter "wcode" (figlet, font "ANSI Shadow") as the session
  // home page. Meta rides beside the logo on wide terminals, stacks beneath
  // it on medium ones, and a mini logo keeps every row inside the terminal
  // when narrow — a wrapped banner row would corrupt the bottom-region row
  // accounting. Rebuilt on resize so ctrl+l always prints the right width.
  const LOGO = [
    "██╗    ██╗ ██████╗ ██████╗ ██████╗ ███████╗",
    "██║    ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝",
    "██║ █╗ ██║██║     ██║   ██║██║  ██║█████╗  ",
    "██║███╗██║██║     ██║   ██║██║  ██║██╔══╝  ",
    "╚███╔███╔╝╚██████╗╚██████╔╝██████╔╝███████╗",
    " ╚══╝╚══╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
  ];
  const LOGO_WIDTH = 43;
  function buildBanner(): string {
    const logoStyled = LOGO.map((r) => style.bold(fg.cyan(padToWidth(r, LOGO_WIDTH))));
    const meta1 = `wcode v${VERSION}`;
    const meta2 = `model: ${controller.modelKey} · ${shortCwd(options.cwd)}`;
    const hint = style.dim("type a task · ctrl+p palette · /help for commands · /exit to quit");
    const termW = width();
    if (termW < LOGO_WIDTH + 3) {
      return [
        `${style.bold("▄▄▄")}  ${style.bold("wcode")} ${style.dim("v" + VERSION)}`,
        `${style.bold("█▀█")}  ${style.dim("model:")} ${fg.cyan(controller.modelKey)}`,
        `${style.bold("█▄█")}  ${style.dim("/help · /exit to quit")}`,
      ].join("\n");
    }
    if (termW >= LOGO_WIDTH + 2 + stringWidth(meta1) + 2) {
      return [
        logoStyled[0]!,
        `${logoStyled[1]}  ${style.bold(meta1)}`,
        `${logoStyled[2]}  ${style.dim(truncate(meta2, termW - LOGO_WIDTH - 3))}`,
        logoStyled[3]!,
        logoStyled[4]!,
        logoStyled[5]!,
        "",
        ` ${clampWidth(hint, termW - 2)}`,
      ].join("\n");
    }
    return [
      ...logoStyled,
      ` ${clampWidth(`${style.bold(meta1)} · ${style.dim(meta2)}`, termW - 1)}`,
      "",
      ` ${clampWidth(hint, termW - 2)}`,
    ].join("\n");
  }
  let banner = buildBanner();
  printAbove(banner);
  if (controller.resumeNotice !== "") printAbove(style.dim(controller.resumeNotice));
  drawBottom(true);

  // `wcode "fix the failing test"` — start working immediately (claude-code
  // passes the CLI prompt straight into the session).
  if (options.initialPrompt !== undefined && options.initialPrompt.trim() !== "") {
    void runLine(expandPastes(options.initialPrompt.trim()));
  }

  // wait until quit() exits the process
  await new Promise(() => {});
}

// ----- helpers --------------------------------------------------------------

// Prompt history persisted across sessions (opencode keeps per-session drafts;
// wcode keeps a shared recent-prompt file, oldest first).
const HISTORY_FILE = join(CONFIG_DIR, "history.jsonl");
const HISTORY_LIMIT = 500;

function loadHistory(): string[] {
  try {
    return readFileSync(HISTORY_FILE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-HISTORY_LIMIT)
      .map((l) => {
        try {
          return JSON.parse(l) as string;
        } catch {
          return "";
        }
      })
      .filter((s) => s !== "");
  } catch {
    return [];
  }
}

function appendHistory(text: string): void {
  try {
    appendFileSync(HISTORY_FILE, JSON.stringify(text) + "\n");
  } catch {
    /* best effort */
  }
}

function shortCwd(cwd: string): string {
  return cwd.replace(/^\/Users\/[^/]+/, "~");
}

function truncate(s: string, max: number): string {
  if (stringWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** Clamp a styled string to a display width (ANSI codes don't count). */
function clampWidth(s: string, max: number): string {
  const plain = stripAnsi(s);
  if (stringWidth(plain) <= max) return s;
  let out = "";
  let w = 0;
  const limit = Math.max(1, max - 1);
  let i = 0;
  while (i < s.length) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = [...s.slice(i)][0]!;
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > limit) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + "…";
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
