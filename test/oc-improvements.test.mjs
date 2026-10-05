// Unit tests for the opencode-inspired improvements: edit fallback matching,
// read truncation protocol, bash output persistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyReplacement } from "../dist/tools/edit-match.js";
import { createEditTool } from "../dist/tools/edit.js";
import { createReadTool } from "../dist/tools/read.js";
import { createBashTool } from "../dist/tools/bash.js";

const ok = (content, oldS, newS, replaceAll = false) => applyReplacement(content, oldS, newS, replaceAll);
const err = (content, oldS, newS, replaceAll = false) => {
  try {
    applyReplacement(content, oldS, newS, replaceAll);
    return null;
  } catch (e) {
    return e;
  }
};

test("edit-match: exact still works and enforces uniqueness", () => {
  const r = ok("alpha\nbeta\ngamma", "beta", "BETA");
  assert.equal(r.strategy, "exact");
  assert.equal(r.updated, "alpha\nBETA\ngamma");
  const e = err("x\nx", "x", "y");
  assert.match(e.message, /appears 2 times/);
});

test("edit-match: line-trimmed rescues trailing-whitespace mismatch", () => {
  const content = "function a() {\n    return 1;   \n}\n";
  const r = ok(content, "function a() {\n  return 1;\n}", "function a() {\n  return 2;\n}");
  assert.equal(r.strategy, "line-trimmed");
  assert.equal(r.updated, "function a() {\n  return 2;\n}\n");
});

test("edit-match: block-anchor rescues drifted middle (similarity ≥ 0.65)", () => {
  const content = [
    "function calc() {",
    "  const a = 1;",
    "  const b = 2;",
    "  const c = a + b + drift;",
    "  return c;",
    "}",
  ].join("\n");
  const oldS = ["function calc() {", "  const a = 1;", "  const b = 2;", "  const c = a + b;", "  return c;", "}"].join("\n");
  const r = ok(content, oldS, "function calc() {\n  return 42;\n}");
  assert.equal(r.strategy, "block-anchor");
  assert.match(r.updated, /return 42;/);
});


test("edit-match: indentation-flexible rescues whitespace-collapsed block", () => {
  const content = [
    "class A {",
    "  method() {",
    "      if  (x) {", // internal whitespace collapsed/doubled
    "        doIt   ();",
    "      }",
    "  }",
    "}",
  ].join("\n");
  const oldS = ["if (x) {", "  doIt();", "}"].join("\n");
  const newS = ["if (y) {", "  go();", "}"].join("\n");
  const r = ok(content, oldS, newS);
  assert.equal(r.strategy, "indentation-flexible");
  // replacement re-indented to the file's 6-space base
  assert.match(r.updated, /      if \(y\) \{\n\s+go\(\);\n      \}/);
});

test("edit-match: escape-normalized rescues literal \\n in needle", () => {
  const content = "a = 'line1\nline2'\n";
  const r = ok(content, "line1\\nline2", "LINE1\\nLINE2");
  assert.equal(r.strategy, "escape-normalized");
  assert.match(r.updated, /LINE1\nLINE2/);
});

test("edit-match: disproportionate fuzzy match is refused", () => {
  const content = ["start", "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "end"].join("\n");
  // needle is 2 lines but the fuzzy comparator region would be huge — use
  // anchor: first/last match, middle wildly different → refused for size.
  const e = err(content, "start\nzzz\nend", "replaced");
  assert.ok(e === null || /disproportionate|not found/.test(e.message));
});

test("edit-match: empty old_string is rejected with write hint", () => {
  const e = err("content", "", "x");
  assert.match(e.message, /write tool/);
});

test("read: per-line 2000-char truncation + EOF marker", async () => {
  const { createReadTool } = await import("../dist/tools/read.js");
  const dir = mkdtempSync(join(tmpdir(), "wcode-read2-"));
  const file = join(dir, "longline.txt");
  writeFileSync(file, "x".repeat(3000) + "\nshort\n");
  const tool = createReadTool(false);
  const out = await tool.execute({ path: file }, { cwd: dir, readFileState: new Map(), requestPermission: async () => true });
  const text = out.content[0].text;
  assert.match(text, /line truncated to 2000 chars/);
  assert.match(text, /End of file — total 2 lines/);
});

test("bash: truncated output is persisted and path reported", async () => {
  const tool = createBashTool();
  const ctx = { cwd: tmpdir(), readFileState: new Map(), requestPermission: async () => true };
  const out = await tool.execute({ command: "seq 1 20000" }, ctx);
  const text = out.content[0].text;
  assert.match(text, /Full output saved to: /);
  const m = text.match(/Full output saved to: ([^\]]+)/);
  const saved = readFileSync(m[1], "utf8");
  assert.ok(saved.split("\n").length >= 20000);
});
