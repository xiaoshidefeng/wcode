// Terminal input sequence parser — trimmed port of opentui's
// parse.keypress.ts (MIT, © 2025 opentui, itself adapted from enquirer's
// keypress.js). Handles CSI/SS3 sequences (including application-cursor-mode
// arrows like ESC O A), modifier codes, rxvt variants, control bytes, and
// mouse/terminal-response noise — with buffering so sequences split across
// stdin reads assemble correctly.
//
// Skipped from the original: kitty keyboard protocol and modifyOtherKeys
// (wcode doesn't enable them).

const keyName: Record<string, string> = {
  /* xterm/gnome ESC O letter (application cursor mode) */
  OP: "f1",
  OQ: "f2",
  OR: "f3",
  OS: "f4",
  "[11~": "f1",
  "[12~": "f2",
  "[13~": "f3",
  "[14~": "f4",
  "[[A": "f1",
  "[[B": "f2",
  "[[C": "f3",
  "[[D": "f4",
  "[[E": "f5",
  "[15~": "f5",
  "[17~": "f6",
  "[18~": "f7",
  "[19~": "f8",
  "[20~": "f9",
  "[21~": "f10",
  "[23~": "f11",
  "[24~": "f12",
  /* common CSI */
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[F": "end",
  "[H": "home",
  "[P": "f1",
  "[Q": "f2",
  "[S": "f4",
  /* SS3 (application cursor keypad) */
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
  OF: "end",
  OH: "home",
  OM: "return",
  "[1~": "home",
  "[2~": "insert",
  "[3~": "delete",
  "[4~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",
  "[[5~": "pageup",
  "[[6~": "pagedown",
  "[7~": "home",
  "[8~": "end",
  /* rxvt / modified variants */
  "[a": "up",
  "[b": "down",
  "[c": "right",
  "[d": "left",
  "[Z": "tab",
  "[3$": "delete",
  "[5$": "pageup",
  "[6$": "pagedown",
  "[7$": "home",
  "[8$": "end",
  "[3^": "delete",
  "[5^": "pageup",
  "[6^": "pagedown",
};

const shiftCodes = new Set(["[a", "[b", "[c", "[d", "[2$", "[3$", "[5$", "[6$", "[7$", "[8$", "[Z"]);
const ctrlCodes = new Set(["[3^", "[5^", "[6^", "[7^", "[8^"]);

const fnKeyRe = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;
const metaKeyCodeRe = /^\x1b([a-zA-Z0-9])$/;

function ctrlKeyName(charCode: number): string | undefined {
  if (charCode === 0) return "space";
  if (charCode >= 1 && charCode <= 26) return String.fromCharCode(charCode + 96);
  if (charCode >= 28 && charCode <= 31) return String.fromCharCode(charCode + 64);
  return undefined;
}

export interface ParsedKey {
  /** Canonical key name (up/down/left/right/home/end/delete/insert/pageup/pagedown/return/tab/backspace/escape/f1..f12) or "" for printable. */
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** Printable text for character keys ("" for named keys). */
  char: string;
  raw: string;
}

const NAMED = new Set([
  "up", "down", "left", "right", "home", "end", "insert", "delete", "pageup", "pagedown",
  "return", "linefeed", "tab", "escape", "space", "backspace", "f1", "f2", "f3", "f4",
  "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

export interface ParseOne {
  key: ParsedKey | null;
  /** Bytes of `s` consumed by this key (noise consumes everything). */
  consumed: number;
}

/** Parse one complete key sequence. Returns null for noise (mouse, terminal
 * responses, paste markers) and "incomplete" when the sequence may continue
 * with more bytes (see KeyStream for buffering). */
export function parseKeypress(s: string): ParsedKey | "incomplete" | null {
  const r = parseOne(s);
  return r === "incomplete" ? "incomplete" : r.key;
}

/** Like parseKeypress but also reports how many leading bytes of `s` the
 * result consumed, so the buffered stream can advance safely. */
export function parseOne(s: string): ParseOne | "incomplete" {
  const r = parseOneInner(s);
  return r;
}

function parseOneInner(s: string): ParseOne | "incomplete" {
  if (s === "") return { key: null, consumed: 0 };

  // Terminal responses / events we never care about.
  if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(s)) return { key: null, consumed: s.length }; // SGR mouse
  if (/^\x1b\[\d+;\d+;\d+t$/.test(s)) return { key: null, consumed: s.length }; // size report
  if (/^\x1b\[\d+;\d+R$/.test(s)) return { key: null, consumed: s.length }; // cursor position (DSR)
  if (/^\x1b\[\?[\d;]+c$/.test(s)) return { key: null, consumed: s.length }; // device attributes
  if (s === "\x1b[I" || s === "\x1b[O") return { key: null, consumed: s.length }; // focus in/out
  if (s === "\x1b[200~" || s === "\x1b[201~") return { key: null, consumed: 6 }; // paste markers

  const key: ParsedKey = { name: "", ctrl: false, meta: false, shift: false, char: "", raw: s };

  // Control bytes: ctrl+a..z (0x01-0x1a), ctrl+\..ctrl+_ (0x1c-0x1f), backspace, escape
  if (s.length === 1) {
    const code = s.charCodeAt(0);
    if (s === "\r") {
      key.name = "return";
      return { key, consumed: 1 };
    }
    if (s === "\n") {
      key.name = "linefeed";
      return { key, consumed: 1 };
    }
    if (s === "\t") {
      key.name = "tab";
      return { key, consumed: 1 };
    }
    if (s === "\x7f") {
      key.name = "backspace";
      return { key, consumed: 1 };
    }
    if (code === 27) {
      key.name = "escape";
      return { key, consumed: 1 };
    }
    if (code < 32) {
      const name = ctrlKeyName(code);
      if (name) {
        key.name = name;
        key.ctrl = true;
        return { key, consumed: 1 };
      }
    }
    key.char = s;
    return { key, consumed: s.length };
  }

  // ESC-prefixed sequence
  if (s[0] === "\x1b") {
    // Meta + control byte (ESC ctrl+x)
    if (s.length === 2) {
      const name = ctrlKeyName(s.charCodeAt(1));
      if (name) {
        key.name = name;
        key.ctrl = true;
        key.meta = true;
        return { key, consumed: 2 };
      }
    }
    const m = fnKeyRe.exec(s) || metaKeyCodeRe.exec(s);
    if (m) {
      // Rebuild the canonical table key: "O"+"A" → "OA", "["+"3"+"~" → "[3~"
      let seq: string;
      if (m[4] !== undefined) seq = (m[1] ?? "") + (m[2] ?? "") + m[4];
      else seq = (m[1] ?? "") + (m[6] ?? "");
      const name = keyName[seq];
      if (name) {
        key.name = name;
        if (NAMED.has(name) === false) key.char = name;
        key.shift = shiftCodes.has(seq);
        key.ctrl = ctrlCodes.has(seq);
        if (m[3] !== undefined) {
          const mod = parseInt(m[3], 10) - 1;
          key.shift = !!(mod & 1);
          key.meta = !!(mod & 2);
          key.ctrl = !!(mod & 4);
        }
        return { key, consumed: m[0].length };
      }
      return { key: null, consumed: s.length }; // unknown CSI — drop
    }
    // bare ESC followed by one printable = meta+char (alt+b/f, option keys)
    if (s.length === 2) {
      key.name = s[1]!;
      key.char = s[1]!;
      key.meta = true;
      return { key, consumed: 2 };
    }
    // Unknown longer sequence starting with ESC — wait: it may still complete.
    return isIncompleteEscape(s) ? "incomplete" : { key: null, consumed: s.length };
  }

  // Run of printable characters
  key.char = s;
  return { key, consumed: s.length };
}

/** Heuristic: does `s` look like the start of an unfinished escape sequence? */
function isIncompleteEscape(s: string): boolean {
  return /^\x1b$/.test(s) || /^\x1b\[[0-9;]*$/.test(s) || /^\x1bO$/.test(s) || /^\x1b\[\[[0-9]?$/.test(s);
}

/** Does `s` prefix-match any known escape sequence shape? (for buffering) */
function mayBeSequencePrefix(s: string): boolean {
  if (!s.startsWith("\x1b")) return false;
  if (s === "\x1b") return true;
  if (/^\x1b\[[0-9;]*$/.test(s)) return true; // CSI without final byte
  if (/^\x1bO$/.test(s)) return true; // SS3 without letter
  if (/^\x1b\[\[[0-9]*$/.test(s)) return true;
  return false;
}

const ESC_FLUSH_MS = 40;

/**
 * Buffered stdin key stream: assembles sequences that arrive split across
 * reads, disambiguates a lone ESC (waits ESC_FLUSH_MS for a possible
 * sequence), and folds bracketed-paste chunks into verbatim paste events.
 */
export class KeyStream {
  private buf = "";
  private decoderPending = false;
  private escTimer: NodeJS.Timeout | null = null;
  private inPaste = false;
  private pasteBuf = "";

  constructor(private readonly onKey: (key: ParsedKey) => void, private readonly onPaste: (text: string) => void) {}

  feed(data: string): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    if (this.inPaste) {
      this.pasteBuf += data;
      this.tryCompletePaste();
      return;
    }
    this.buf += data;
    // Bracketed paste start may sit after other bytes in the same chunk.
    const start = this.buf.indexOf("\x1b[200~");
    if (start !== -1) {
      const before = this.buf.slice(0, start);
      this.pasteBuf = this.buf.slice(start + 6);
      this.buf = before;
      this.inPaste = true;
      if (before !== "") this.feed(before);
      this.tryCompletePaste();
      return;
    }
    this.drain();
  }

  private tryCompletePaste(): void {
    const end = this.pasteBuf.indexOf("\x1b[201~");
    if (end === -1) return;
    const text = this.pasteBuf.slice(0, end);
    const rest = this.pasteBuf.slice(end + 6);
    this.inPaste = false;
    this.pasteBuf = "";
    this.onPaste(text);
    if (rest !== "") this.feed(rest);
  }

  private drain(): void {
    // A lone ESC waits ESC_FLUSH_MS: it may be the head of a sequence that
    // arrives split across reads. If nothing follows, it is the escape key.
    if (this.buf === "\x1b") {
      if (!this.escTimer) {
        this.escTimer = setTimeout(() => {
          this.escTimer = null;
          if (this.buf === "\x1b") {
            this.buf = "";
            this.onKey({ name: "escape", ctrl: false, meta: false, shift: false, char: "", raw: "\x1b" });
          } else if (this.buf !== "") {
            this.drain();
          }
        }, ESC_FLUSH_MS);
      }
      return;
    }
    while (this.buf !== "") {
      if (this.buf === "\x1b") return; // re-arm the wait on the next feed
      // A run of printable characters: emit as one char event for IME friendliness.
      if (!this.buf.startsWith("\x1b") && this.buf.charCodeAt(0) >= 32) {
        let i = 0;
        while (i < this.buf.length && !this.buf.startsWith("\x1b", i) && this.buf.charCodeAt(i) >= 32) i++;
        const run = this.buf.slice(0, i);
        this.buf = this.buf.slice(i);
        const parsed = parseKeypress(run);
        if (parsed && parsed !== "incomplete") this.onKey(parsed);
        continue;
      }
      const r = parseOne(this.buf);
      if (r === "incomplete" || mayBeSequencePrefix(this.buf)) {
        return; // wait for more bytes (feed() cancels/re-drains)
      }
      if (r.key) this.onKey(r.key);
      this.buf = this.buf.slice(r.consumed);
      if (r.consumed === 0) return; // safety: never spin
    }
  }

}
