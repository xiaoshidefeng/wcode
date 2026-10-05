// TUI frontend — the Claude-Code-style experience: bordered input box pinned
// to the bottom, streaming output scrolling above it, status line, slash
// command hints, markdown-lite rendering, Esc/Ctrl+C interrupt.
//
// Hand-rolled on raw-mode key handling (no readline): we own the whole input
// area, so the box can wrap the cursor. Multi-line input works for pastes
// (bracketed paste) and backslash continuations.

import { StringDecoder } from "node:string_decoder";
import type { AgentEvent } from "../agent/agent.js";
import type { SessionOptions } from "./session.js";
import { SessionController } from "./session.js";
import { fg, style } from "./render.js";
import { VERSION } from "../version.js";
import { listFiles } from "../tools/util.js";
import { KeyStream, type ParsedKey } from "./keys.js";
import type { ToolPermissionRequest } from "../tools/types.js";
import type { ModelEntry } from "../config.js";

// ---------------------------------------------------------------------------
// Display-width helpers (CJK chars occupy 2 terminal columns)
// ---------------------------------------------------------------------------

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

  handleKey(data: string): "submit" | "abort" | "quit" | "tab" | null {
    const st = this.state;
    const line = () => st.lines[st.line]!;
    const setLine = (s: string) => (st.lines[st.line] = s);

    if (data === "\r" || data === "\n") {
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
      if (st.lines.length === 1 && line() === "") {
        this.recallHistory(1);
      } else if (st.line > 0) {
        st.line--;
        st.col = Math.min(st.col, st.lines[st.line]!.length);
      }
      return null;
    }
    if (data === "\x1b[B") {
      if (st.line < st.lines.length - 1) {
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
      this.historyDraft = "";
      this.historyIndex = this.history.length;
    }
    const next = this.historyIndex + dir;
    if (next < 0 || next > this.history.length) return;
    if (this.historyIndex === this.history.length) this.historyDraft = this.text;
    this.historyIndex = next;
    this.reset(next === this.history.length ? this.historyDraft : this.history[next]!);
  }

  pushHistory(text: string): void {
    if (text.trim() !== "" && this.history[this.history.length - 1] !== text) this.history.push(text);
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
  const md = new LineBufferStreamer(styleMarkdownLine);
  const thinking = new LineBufferStreamer(styleThinkingLine);
  const decoder = new StringDecoder("utf8");

  let menuItems: { name: string; args?: string; description: string }[] = [];
  let menuIndex = 0;
  let fileMenu: { items: string[]; index: number; from: number } | null = null;
  let fileIndex: string[] | null = null;
  const pastes = new Map<string, string>();
  let pasteSeq = 0;
  // interactive /models picker (arrow keys + enter to switch)
  let picker: { items: ModelEntry[]; index: number } | null = null;
  let transientLines: string[] = []; // spinner/status lines rendered above the box
  let mode: "input" | "permission" | "exiting" = "input";
  let permissionResolve: ((ok: boolean) => void) | null = null;
  let queuedPrompt: string | null = null;
  let streaming = false;
  // unified busy spinner (waiting for model / tools running)
  let spinTimer: NodeJS.Timeout | null = null;
  let spinActive = false;
  let spinnerFrame = 0;
  let spinStartedAt = 0;
  const SPIN = ["✻", "✽", "✶", "✳"];
  const TOOL_SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinIsTool = false;
  let spinLabel = "";
  let lastEscAt = 0;

  const controller = new SessionController(options, {
    print: (line) => printAbove(line),
    onEvent: handleAgentEvent,
    askPermission: askPermission,
    askPlanApproval: askPlanApproval,
  });

  /** shift+tab: cycle build → edit → plan (claude-code convention). Ignored mid-prompt. */
  function toggleMode(): void {
    const m = controller.toggleMode();
    const notice =
      m === "plan"
        ? `${fg.magenta("⏸ plan mode on")} ${style.dim("— read-only research · agent submits its plan via exit_plan")}`
        : m === "edit"
          ? `${fg.cyan("⏵⏵ edit mode on")} ${style.dim("— file edits auto-approved · bash still asks")}`
          : `${fg.green("● build mode")} ${style.dim("— file edits ask for approval")}`;
    printAbove(notice);
  }

  // Background file index for @-completion (gitignore-aware, capped).
  void listFiles(options.cwd, { maxEntries: 3000 }).then(
    (files) => (fileIndex = files),
    () => (fileIndex = []),
  );

  // ----- bottom area drawing ----------------------------------------------

  const statusText = () => {
    const t = controller.totals;
    const tok = t.inputTokens + t.outputTokens > 0 ? ` · in ${fmtK(t.inputTokens)} out ${fmtK(t.outputTokens)}` : "";
    const limit = controller.model.model.contextWindow;
    const pct = limit ? Math.min(100, Math.round((controller.contextTokens / limit) * 100)) : 0;
    const ctx = controller.contextTokens > 0 ? ` · ctx ${pct}%` : "";
    const cost = t.cost > 0 ? ` · $${t.cost >= 0.01 ? t.cost.toFixed(2) : t.cost.toFixed(4)}` : "";
    const dir = shortCwd(options.cwd);
    const modeLabel = controller.mode === "plan" ? " · plan mode" : controller.mode === "edit" ? " · edit mode" : "";
    const todos = controller.todos;
    const tasks = todos.length > 0 ? ` · ${todos.filter((x) => x.status === "completed").length}/${todos.length} tasks` : "";
    return ` ${controller.modelKey} · ${dir}${tok}${ctx}${cost}${controller.policy === "yolo" ? " · yolo" : ""}${modeLabel}${tasks} `;
  };

  // Cursor anchor tracking (the invariant every draw maintains):
  // after drawBottom, the cursor sits at the edit position inside the input
  // box. cursorRowInRegion = rows below the region's top row where the cursor
  // rests — captured at draw time so clears use the OLD position even when
  // the editor state has since changed.
  let bottomRows = 0;
  let cursorRowInRegion = 0;

  function clearRegion(): void {
    if (bottomRows > 0) {
      if (cursorRowInRegion > 0) stdout.write(`\x1b[${cursorRowInRegion}A`);
      stdout.write("\r\x1b[J");
    }
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

  function drawBottom(clearFirst: boolean): void {
    const w = width();
    if (clearFirst) clearRegion();
    const lines: string[] = [];
    const topRows = picker ? renderPicker(w) : fileMenu ? renderFileMenu(w) : renderMenu(w);
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
    stdout.write(lines.join("\r\n") + "\r");
    // reposition: cursor rests on the bottom-border row after the write; the
    // input row is exactly (inputLines.length - line) rows above it.
    const up = inputLines.length - editor.state.line;
    const visibleBefore = visibleSlice(
      editor.state.lines[editor.state.line]!,
      editor.state.col,
      available,
    );
    const cursorCol = 4 + stringWidth(visibleBefore.text.slice(0, editor.state.col - visibleBefore.colOffset));
    stdout.write(`\x1b[${up}A\r\x1b[${Math.min(cursorCol, w - 3)}C`);
    cursorRowInRegion = topRows.length + transientLines.length + 1 + editor.state.line;
  }

  function printAbove(text: string): void {
    clearRegion();
    stdout.write(text.replace(/\n/g, "\r\n") + "\r\n");
    drawBottom(false);
  }

  // ----- busy spinner (Claude-Code-style loading animation) ----------------

  function spinElapsed(): string {
    const s = Math.max(0, Math.round((Date.now() - spinStartedAt) / 1000));
    const t = controller.totals;
    const tok = t.inputTokens + t.outputTokens > 0 ? ` · ${fmtK(t.inputTokens + t.outputTokens)} tok` : "";
    return `(${s}s · esc×2 to interrupt${tok})`;
  }

  function renderSpin(): void {
    const w = width();
    if (spinIsTool) {
      const frame = TOOL_SPIN[spinnerFrame % TOOL_SPIN.length]!;
      transientLines = [`  ${fg.cyan(frame)} ${fg.cyan(truncate(spinLabel, w - 10))}`];
    } else {
      const frame = SPIN[spinnerFrame % SPIN.length]!;
      transientLines = [`  ${fg.magenta(frame)} ${style.bold(truncate(spinLabel, w - 20))} ${style.dim(spinElapsed())}`];
    }
  }

  function startSpin(label: string, isTool = false): void {
    spinLabel = label;
    spinIsTool = isTool;
    if (!isTool) spinStartedAt = Date.now();
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
        thinking.feed(event.delta, (line) => printAbove(line));
        break;
      case "tool_start":
        startSpin(`● ${event.call.name}${event.summary ? `: ${truncate(event.summary, width() - 12)}` : ""}`, true);
        break;
      case "tool_update":
        spinLabel = `● ${truncate(event.line, width() - 12)}`;
        break;
      case "tool_end": {
        stopSpin();
        const icon = event.isError ? fg.red("✗") : fg.green("✓");
        const summary = event.output.display ? ` · ${style.dim(event.output.display)}` : "";
        const lines = [`  ${icon} ${style.bold(event.call.name)}${summary}`];
        if (event.output.detail) {
          const detailLines = event.output.detail.split("\n");
          for (const l of detailLines.slice(0, 20)) lines.push(style.dim(`  │ ${l}`));
          if (detailLines.length > 20) lines.push(style.dim("  │ …"));
        }
        printAbove(lines.join("\r\n"));
        break;
      }
      case "message_end":
        stopSpin();
        thinking.flush((line) => printAbove(line));
        md.flush((line) => printAbove(line));
        printAbove("");
        break;
      case "notice":
        printAbove(style.dim(`─ ${event.message} ─`));
        break;
      case "turn_end": {
        stopSpin();
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

  // ----- permission prompts -------------------------------------------------

  /** Shared y/N prompt: takes over the bottom area until y/n/esc/enter. */
  function promptYesNo(lines: string[], denyLine: string | null): Promise<boolean> {
    return new Promise((resolve) => {
      mode = "permission";
      permissionResolve = (ok) => {
        if (!ok && denyLine !== null) printAbove(denyLine);
        resolve(ok);
      };
      stopSpin();
      if (bottomRows > 0) stdout.write(`\x1b[${bottomRows}A\r\x1b[J`);
      transientLines = [];
      stdout.write(lines.join("\r\n") + "\r\n");
      bottomRows = 0;
    });
  }

  function askPermission(req: ToolPermissionRequest): Promise<boolean> {
    const detail = req.detail
      ? req.detail
          .split("\n")
          .slice(0, 16)
          .map((l) => (l.startsWith("+") ? fg.green(l) : l.startsWith("-") ? fg.red(l) : style.dim(l)))
          .join("\r\n")
      : "";
    return promptYesNo(
      [
        `${fg.yellow(`● ${req.tool}`)} ${req.summary.length > 100 ? req.summary.slice(0, 100) + "…" : req.summary}`,
        detail,
        `${fg.yellow("allow this action?")} ${style.dim("[y] yes · [n] no · [esc] no")}`,
      ].filter((s) => s !== ""),
      style.dim("denied"),
    );
  }

  /** Answer the active y/N prompt (permission or plan approval). */
  function answerPrompt(ok: boolean): void {
    const resolve = permissionResolve;
    permissionResolve = null;
    mode = "input";
    resolve?.(ok);
  }

  /** Plan approval (exit_plan): y switches to build mode and implements. */
  function askPlanApproval(req: { plan: string; planFile: string }): Promise<boolean> {
    const allLines = req.plan.split("\n");
    const head = allLines.slice(0, 14).map((l) => style.dim(`  │ ${l}`));
    if (allLines.length > 14) head.push(style.dim("  │ …"));
    return promptYesNo(
      [
        `${fg.magenta("⏸ plan ready for review")} ${style.dim(`· ${req.planFile}`)}`,
        ...head,
        `${fg.magenta("approve this plan?")} ${style.dim("[y] start implementing · [n] keep planning")}`,
      ],
      style.dim("plan kept — still in plan mode"),
    );
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
    const keys = data.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b[0-9A-Za-z]|\r|\n|\x7f|\t|\x03|\x04|\x01|\x05|\x0b|\x15|\x17|[\s\S]/g) ?? [];
    for (const key of keys) {
      if (mode === "permission") {
        if (key === "y" || key === "Y") answerPrompt(true);
        else if (key === "n" || key === "N" || key === "\x03" || key === "\x1b" || key === "\r") answerPrompt(false);
        continue;
      }
      // Model picker captures all keys while open.
      if (picker) {
        const n = picker.items.length;
        if (key === "\x1b[A") {
          picker.index = (picker.index - 1 + n) % n;
          drawBottom(true);
        } else if (key === "\x1b[B") {
          picker.index = (picker.index + 1) % n;
          drawBottom(true);
        } else if (key === "\r") {
          const target = picker.items[picker.index]!;
          closePicker();
          printAbove(`${style.bold(fg.magenta("> /models"))}`);
          printAbove(controller.switchModel(target.key));
        } else if (key === "\x1b" || key === "\x03" || key === "\x04") {
          closePicker();
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
        continue;
      }
      if (key === "\x1b" && controller.busy) {
        // double-press to interrupt (opencode-style, guards against accidents)
        if (Date.now() - lastEscAt < 5000) {
          controller.abort();
          printAbove(style.dim("· interrupted ·"));
          lastEscAt = 0;
        } else {
          lastEscAt = Date.now();
          printAbove(style.dim("press esc again to interrupt"));
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

  function renderPicker(w: number): string[] {
    const items = picker!.items;
    const rows = [style.dim("  select model · ↑↓ move · enter switch · esc cancel")];
    items.forEach((entry, i) => {
      const mark = entry.available ? fg.green("✓") : fg.red("✗");
      const api = style.dim(` ${entry.provider.api}`);
      const current = entry.key === controller.modelKey ? fg.green(" · current") : "";
      const label = `${mark} ${entry.key}${api}${current}`;
      if (i === picker!.index) {
        rows.push(clampWidth(`  ${style.bold(fg.cyan(`❯ ${label}`))}`, w - 2));
      } else {
        rows.push(clampWidth(style.dim(`    ${label}`), w - 2));
      }
    });
    return rows;
  }

  function openPicker(): void {
    const items = controller.configuredModels();
    if (items.length === 0) {
      printAbove(style.dim("no models configured. See /help or wcode help."));
      return;
    }
    const currentIdx = items.findIndex((e) => e.key === controller.modelKey);
    picker = { items, index: currentIdx >= 0 ? currentIdx : 0 };
    menuItems = [];
    drawBottom(true);
  }

  function closePicker(): void {
    picker = null;
    drawBottom(true);
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
  async function submit(): Promise<void> {
    // Enter with the slash menu open executes the highlighted command: expand
    // the box to the resolved command FIRST, so the /models interception below
    // also covers menu execution (typing "/mo" + enter must open the picker).
    if (menuItems.length > 0) {
      editor.reset(`/${menuItems[menuIndex]!.name}`);
      menuItems = [];
      menuIndex = 0;
    }
    // /models opens the interactive picker instead of printing a list.
    if (editor.text.trim() === "/models") {
      editor.reset();
      updateHints();
      printAbove(`${style.bold(fg.magenta("> /models"))}`);
      openPicker();
      return;
    }
    let text = editor.text.replace(/\\\n$/s, "\n").trim();
    if (text === "") {
      drawBottom(true);
      return;
    }
    text = expandPastes(text);
    if (running) {
      queuedPrompt = text; // compose next message while the agent works
      editor.reset();
      updateHints();
      drawBottom(true);
      return;
    }
    editor.pushHistory(text);
    editor.reset();
    updateHints();
    printAbove(`${style.bold(fg.magenta("> " + (text.length > 400 ? text.slice(0, 400) + "…" : text)))}`);
    startSpin("Working…");
    running = true;
    streaming = true;
    try {
      const outcome = await controller.handleLine(text);
      if (outcome.kind === "prompt") await controller.runPrompt(text);
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
    if (mode === "exiting") return;
    if (queuedPrompt !== null) {
      const next = queuedPrompt;
      queuedPrompt = null;
      printAbove(`${style.bold(fg.magenta("> " + truncate(next, 400)))}`);
      startSpin("Working…");
      running = true;
      try {
        const outcome = await controller.handleLine(next);
        if (outcome.kind === "prompt") await controller.runPrompt(next);
        else if (outcome.kind === "exit") {
          mode = "exiting";
          quit();
          return;
        }
      } finally {
        running = false;
        stopSpin();
      }
    }
    drawBottom(true);
  }

  // ----- lifecycle ---------------------------------------------------------

  const cleanup = () => {
    if (spinTimer) clearTimeout(spinTimer);
    stdout.write("\x1b[?2004l"); // bracketed paste off
    stdin.setRawMode(false);
    stdin.pause();
  };

  const onResize = () => drawBottom(true);
  stdout.on("resize", onResize);

  function quit(): void {
    cleanup();
    stdout.on("resize", onResize);
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

  // banner: block-letter "wcode" (figlet, font "ANSI Shadow") as the session
  // home page. Meta rides beside the logo on wide terminals, stacks beneath
  // it on medium ones, and a mini logo keeps every row inside the terminal
  // when narrow — a wrapped banner row would corrupt the bottom-region row
  // accounting.
  const LOGO = [
    "██╗    ██╗ ██████╗ ██████╗ ██████╗ ███████╗",
    "██║    ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝",
    "██║ █╗ ██║██║     ██║   ██║██║  ██║█████╗  ",
    "██║███╗██║██║     ██║   ██║██║  ██║██╔══╝  ",
    "╚███╔███╔╝╚██████╗╚██████╔╝██████╔╝███████╗",
    " ╚══╝╚══╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
  ];
  const LOGO_WIDTH = 43;
  const logoStyled = LOGO.map((r) => style.bold(fg.cyan(padToWidth(r, LOGO_WIDTH))));
  const meta1 = `wcode v${VERSION}`;
  const meta2 = `model: ${controller.modelKey} · ${shortCwd(options.cwd)}`;
  const hint = style.dim("type a task · /help for commands · /exit to quit");
  let banner: string;
  const termW = width();
  if (termW < LOGO_WIDTH + 3) {
    banner = [
      `${style.bold("▄▄▄")}  ${style.bold("wcode")} ${style.dim("v" + VERSION)}`,
      `${style.bold("█▀█")}  ${style.dim("model:")} ${fg.cyan(controller.modelKey)}`,
      `${style.bold("█▄█")}  ${style.dim("/help · /exit to quit")}`,
    ].join("\n");
  } else if (termW >= LOGO_WIDTH + 2 + stringWidth(meta1) + 2) {
    banner = [
      logoStyled[0]!,
      `${logoStyled[1]}  ${style.bold(meta1)}`,
      `${logoStyled[2]}  ${style.dim(truncate(meta2, termW - LOGO_WIDTH - 3))}`,
      logoStyled[3]!,
      logoStyled[4]!,
      logoStyled[5]!,
      "",
      ` ${clampWidth(hint, termW - 2)}`,
    ].join("\n");
  } else {
    banner = [
      ...logoStyled,
      ` ${clampWidth(`${style.bold(meta1)} · ${style.dim(meta2)}`, termW - 1)}`,
      "",
      ` ${clampWidth(hint, termW - 2)}`,
    ].join("\n");
  }
  printAbove(banner);
  drawBottom(true);

  // wait until quit() exits the process
  await new Promise(() => {});
}

// ----- helpers --------------------------------------------------------------

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
