// Custom slash commands: markdown prompt templates from
//   <cwd>/.wcode/commands/*.md     (project)
//   ~/.wcode/commands/*.md         (user)
// Project commands win on name conflicts. Frontmatter carries metadata:
//
//   ---
//   description: Review the current diff
//   argument-hint: [pr-number]
//   ---
//   Review $ARGUMENTS against our coding standards ...
//
// `$ARGUMENTS` is replaced with everything typed after the command name; when
// the template has no placeholder the args are appended as a new section.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";

export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  source: "project" | "user";
  template: string;
}

interface Frontmatter {
  description?: string;
  argumentHint?: string;
  body: string;
}

/** Minimal `key: value` frontmatter parser (--- fenced). */
function splitFrontmatter(raw: string): Frontmatter {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { body: raw };
  const meta: Frontmatter = { body: match[2] ?? "" };
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = line.match(/^([a-zA-Z-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    const v = value!.trim().replace(/^["']|["']$/g, "");
    if (key === "description" && v !== "") meta.description = v;
    if (key === "argument-hint" && v !== "") meta.argumentHint = v;
  }
  return meta;
}

function scanDir(dir: string, source: "project" | "user"): CustomCommand[] {
  if (!existsSync(dir)) return [];
  const out: CustomCommand[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    try {
      const raw = readFileSync(join(dir, entry), "utf8");
      if (raw.trim() === "") continue;
      const name = entry.slice(0, -3).toLowerCase();
      const meta = splitFrontmatter(raw);
      out.push({
        name,
        description: meta.description ?? `custom command (${source})`,
        argumentHint: meta.argumentHint,
        source,
        template: meta.body.trim(),
      });
    } catch {
      /* unreadable file — skip */
    }
  }
  return out;
}

// The slash-command menu loads this on every keystroke — cache it briefly so
// editing doesn't hit the disk several times a second.
let commandsCache: { cwd: string; at: number; commands: CustomCommand[] } | null = null;
const COMMANDS_CACHE_TTL_MS = 2000;

/** Load all custom commands; project entries shadow user entries by name. */
export function loadCustomCommands(cwd: string): CustomCommand[] {
  if (commandsCache && commandsCache.cwd === cwd && Date.now() - commandsCache.at < COMMANDS_CACHE_TTL_MS) {
    return commandsCache.commands;
  }
  const user = scanDir(join(CONFIG_DIR, "commands"), "user");
  const project = scanDir(join(cwd, ".wcode", "commands"), "project");
  const byName = new Map<string, CustomCommand>();
  for (const cmd of user) byName.set(cmd.name, cmd);
  for (const cmd of project) byName.set(cmd.name, cmd);
  const commands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  commandsCache = { cwd, at: Date.now(), commands };
  return commands;
}

/** Expand the template with the user's arguments (claude-code semantics). */
export function expandCommand(cmd: CustomCommand, args: string): string {
  const trimmedArgs = args.trim();
  if (cmd.template.includes("$ARGUMENTS")) {
    return cmd.template.replaceAll("$ARGUMENTS", trimmedArgs);
  }
  if (trimmedArgs === "") return cmd.template;
  return `${cmd.template}\n\n<arguments>\n${trimmedArgs}\n</arguments>`;
}

/** Find a custom command by the exact name typed after "/". */
export function findCustomCommand(cwd: string, name: string): CustomCommand | undefined {
  const lower = name.toLowerCase();
  return loadCustomCommands(cwd).find((c) => c.name === lower);
}
