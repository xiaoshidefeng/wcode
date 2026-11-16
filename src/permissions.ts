// Permission rules: allow/deny patterns like `bash(git *)` or `write`,
// resolved before the interactive y/N prompt (settings.json + CLI flags).
//
// Precedence: deny > allow > ask. Deny rules apply in every mode — including
// yolo — so a hard "never run rm -rf" stays enforced even in hands-off runs.
// Matching is a glob on the call's "subject" (bash → command, file tools →
// path, webfetch → url, grep → pattern), case-insensitive.

import { isAbsolute, relative } from "node:path";

export interface ParsedRule {
  tool: string;
  /** Glob on the call subject; absent = matches every call of the tool. */
  pattern?: string;
}

/** Parse "tool" or "tool(pattern)"; null on malformed input. */
export function parseRule(rule: string): ParsedRule | null {
  const trimmed = rule.trim();
  if (trimmed === "") return null;
  const open = trimmed.indexOf("(");
  if (open === -1) {
    if (!/^[a-z0-9_-]+$/i.test(trimmed)) return null;
    return { tool: trimmed.toLowerCase() };
  }
  if (!trimmed.endsWith(")")) return null;
  const toolPart = trimmed.slice(0, open);
  if (!/^[a-z0-9_-]+$/.test(toolPart)) return null; // "bad (rule)" → null, not tool "bad"
  return { tool: toolPart.toLowerCase(), pattern: trimmed.slice(open + 1, -1) };
}

export function ruleMatches(rule: ParsedRule, tool: string, subject: string | undefined): boolean {
  if (rule.tool !== tool.toLowerCase()) return false;
  if (rule.pattern === undefined) return true;
  if (subject === undefined) return false;
  return patternRegex(rule.pattern).test(subject.toLowerCase());
}

/**
 * Rule patterns are command-friendly globs: `*` matches ANY character
 * including "/" and spaces ("bash(rm -rf *)" must reach "rm -rf /tmp/x").
 * This differs from path globs (tools/util globToRegex) where `*` stops at
 * path separators — rules match commands, urls and paths alike.
 */
function patternRegex(pattern: string): RegExp {
  let source = "";
  for (const ch of pattern.toLowerCase()) {
    if (ch === "*") source += "[\\s\\S]*";
    else if (ch === "?") source += "[\\s\\S]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export type PermissionDecision = "deny" | "allow" | "ask";

export class PermissionGate {
  private allow: ParsedRule[];
  private deny: ParsedRule[];

  constructor(allow: string[] = [], deny: string[] = [], readonly label = "settings") {
    this.allow = allow.map(parseRule).filter((r): r is ParsedRule => r !== null);
    this.deny = deny.map(parseRule).filter((r): r is ParsedRule => r !== null);
  }

  /** Hot reload: swap both rule sets in place (a settings file changed). */
  replace(allow: string[], deny: string[]): void {
    this.allow = allow.map(parseRule).filter((r): r is ParsedRule => r !== null);
    this.deny = deny.map(parseRule).filter((r): r is ParsedRule => r !== null);
  }

  get isEmpty(): boolean {
    return this.allow.length === 0 && this.deny.length === 0;
  }

  /** Add an allow rule at runtime ("always allow" from the permission prompt). */
  addAllow(rule: string): void {
    const parsed = parseRule(rule);
    if (parsed && !this.allow.some((r) => r.tool === parsed.tool && r.pattern === parsed.pattern)) {
      this.allow.push(parsed);
    }
  }

  decide(tool: string, subject?: string): PermissionDecision {
    for (const rule of this.deny) {
      if (ruleMatches(rule, tool, subject)) return "deny";
    }
    for (const rule of this.allow) {
      if (ruleMatches(rule, tool, subject)) return "allow";
    }
    return "ask";
  }

  /** The deny rule that fires for this call, for error messages. */
  matchedDeny(tool: string, subject?: string): string | undefined {
    for (const rule of this.deny) {
      if (ruleMatches(rule, tool, subject)) return formatRule(rule);
    }
    return undefined;
  }
}

export function formatRule(rule: ParsedRule): string {
  return rule.pattern === undefined ? rule.tool : `${rule.tool}(${rule.pattern})`;
}

/**
 * The subject a rule matches against: the most identifying argument of the
 * call. Paths are shown relative to the cwd when they live inside it, so
 * `edit(src/**)` works regardless of absolute paths in tool calls.
 */
export function permissionSubject(tool: string, args: Record<string, unknown>, cwd: string): string | undefined {
  const raw = (key: string): string | undefined => (typeof args[key] === "string" ? (args[key] as string) : undefined);
  const command = raw("command");
  if (command !== undefined) return command;
  const url = raw("url");
  if (url !== undefined) return url;
  const pattern = raw("pattern");
  if (pattern !== undefined) return pattern;
  const path = raw("path");
  if (path !== undefined) {
    if (!isAbsolute(path)) return path;
    const rel = relative(cwd, path);
    return rel.startsWith("..") ? path : rel;
  }
  return undefined;
}
