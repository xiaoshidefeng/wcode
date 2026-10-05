// Terminal input parser tests (parser ported from opentui's parse.keypress).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeypress, parseOne, KeyStream } from "../dist/ui/keys.js";

test("parse: CSI arrows, home/end, delete, page keys", () => {
  for (const [seq, name] of [
    ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[C", "right"], ["\x1b[D", "left"],
    ["\x1b[H", "home"], ["\x1b[F", "end"], ["\x1b[3~", "delete"], ["\x1b[5~", "pageup"],
    ["\x1b[6~", "pagedown"], ["\x1b[1~", "home"], ["\x1b[4~", "end"],
  ]) {
    const k = parseKeypress(seq);
    assert.ok(typeof k === "object" && k !== null && k.name === name, `${JSON.stringify(seq)} → ${name}`);
  }
});

test("parse: SS3 application-mode arrows (ESC O A)", () => {
  for (const [seq, name] of [
    ["\x1bOA", "up"], ["\x1bOB", "down"], ["\x1bOC", "right"], ["\x1bOD", "left"],
    ["\x1bOH", "home"], ["\x1bOF", "end"],
  ]) {
    const k = parseKeypress(seq);
    assert.ok(typeof k === "object" && k !== null && k.name === name, `${JSON.stringify(seq)} → ${name}`);
  }
});

test("parse: control bytes map to ctrl+name", () => {
  const k = parseKeypress("\x03");
  assert.ok(typeof k === "object" && k && k.name === "c" && k.ctrl);
  const k2 = parseKeypress("\x01");
  assert.ok(typeof k2 === "object" && k2 && k2.name === "a" && k2.ctrl);
});

test("parse: printable runs come back as char events", () => {
  const k = parseKeypress("你好");
  assert.ok(typeof k === "object" && k && k.char === "你好" && k.name === "");
});

test("parse: noise filtered (paste markers, mouse, DSR, focus)", () => {
  assert.equal(parseKeypress("\x1b[200~"), null);
  assert.equal(parseKeypress("\x1b[201~"), null);
  assert.equal(parseKeypress("\x1b[<0;1;1M"), null);
  assert.equal(parseKeypress("\x1b[10;20R"), null);
  assert.equal(parseKeypress("\x1b[I"), null);
});

test("keystream: escape sequence split across two reads assembles", () => {
  const events = [];
  const ks = new KeyStream((k) => events.push(k.name || `char:${k.char}`), () => events.push("paste"));
  ks.feed("\x1b");
  ks.feed("[B");
  assert.deepEqual(events, ["down"]);
});

test("keystream: lone ESC flushes as escape after the disambiguation window", async () => {
  const events = [];
  const ks = new KeyStream((k) => events.push(k.name || `char:${k.char}`), () => {});
  ks.feed("\x1b");
  assert.deepEqual(events, []); // not decided yet
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(events, ["escape"]);
});

test("keystream: bracketed paste folds verbatim, even split across reads", async () => {
  const events = [];
  const ks = new KeyStream(
    (k) => events.push(k.name || `char:${k.char}`),
    (t) => events.push(`paste:${t}`),
  );
  ks.feed("\x1b[200~line1\nli\x1b"); // ESC here is the head of the end marker
  ks.feed("[201~ne2\x1b[A");
  const paste = events.find((e) => typeof e === "string" && e.startsWith("paste:"));
  assert.equal(paste, "paste:line1\nli");
  assert.equal(events[events.length - 1], "up"); // key after paste parses normally
});

test("parseOne reports consumed length", () => {
  const r = parseOne("\x1b[Brest");
  assert.ok(typeof r === "object" && r !== null && r !== "incomplete");
  assert.equal(r.key?.name, "down");
  assert.equal(r.consumed, 3);
});
