// Settings files: layered JSON config for permission rules + small prefs.
//
//   ~/.wcode/settings.json          user-level
//   <cwd>/.wcode/settings.json      project-level (rules append; theme: project wins)
//
// Shape (both files optional, `//` comments allowed):
//
//   {
//     "theme": "wcode-dark",
//     "permissions": {
//       "allow": ["bash(git *)", "read"],
//       "deny":  ["bash(rm -rf *)"]
//     }
//   }
//
// CLI --allowed-tools / --disallowed-tools merge on top of these lists.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.js";
import { stripJsonComments } from "./jsonc.js";

export interface PermissionSettings {
  allow: string[];
  deny: string[];
}

export interface LoadedSettings {
  settings: PermissionSettings;
  /** Files that actually existed and were read. */
  paths: string[];
  /** Parse failures — surfaced to the user instead of being swallowed. */
  warnings: string[];
  /** Theme preference (project file wins over user file). */
  theme?: string;
}

interface RawSettings {
  theme?: unknown;
  permissions?: { allow?: unknown; deny?: unknown };
}

function readList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function parseSettingsFile(path: string, warnings: string[]): { allow: string[]; deny: string[]; theme?: string } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as RawSettings;
    return {
      allow: readList(parsed.permissions?.allow),
      deny: readList(parsed.permissions?.deny),
      ...(typeof parsed.theme === "string" && parsed.theme !== "" ? { theme: parsed.theme } : {}),
    };
  } catch (err) {
    // Broken settings must not brick the session, but they must not be silent.
    warnings.push(`failed to parse ${path}: ${(err as Error).message} — file ignored`);
    return undefined;
  }
}

/** Merge user + project settings (project rules appended, deny wins anyway). */
export function loadSettings(cwd: string): LoadedSettings {
  const allow: string[] = [];
  const deny: string[] = [];
  const paths: string[] = [];
  const warnings: string[] = [];
  let theme: string | undefined;
  for (const path of [join(CONFIG_DIR, "settings.json"), join(cwd, ".wcode", "settings.json")]) {
    const parsed = parseSettingsFile(path, warnings);
    if (!parsed) continue;
    paths.push(path);
    allow.push(...parsed.allow);
    deny.push(...parsed.deny);
    if (parsed.theme !== undefined) theme = parsed.theme;
  }
  return { settings: { allow, deny }, paths, warnings, ...(theme !== undefined ? { theme } : {}) };
}

/** Persist the theme choice to the user-level settings file. Returns the path. */
export function saveThemeSetting(theme: string): string {
  const path = join(CONFIG_DIR, "settings.json");
  let raw: RawSettings = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as RawSettings;
    } catch {
      raw = {}; // broken file: replace rather than fail the theme switch
    }
  }
  raw.theme = theme;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return path;
}
