// Configuration: built-in providers merged with user config, plus value
// resolution ("${ENV}", "$ENV", "!command") for secrets.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ModelConfig, ProviderConfig, ResolvedModel } from "./types.js";

export interface WCodeConfig {
  /** Default model selector "provider/modelId". */
  defaultModel?: string;
  providers: Record<string, Partial<ProviderConfig>>;
}

export const CONFIG_DIR =
  process.env.WCODE_DIR ?? join(homedir(), ".wcode");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const SESSIONS_DIR = join(CONFIG_DIR, "sessions");

// ---------------------------------------------------------------------------
// Built-in provider catalog. Every field here can be overridden from
// ~/.wcode/config.json; models are upserted by id.
// ---------------------------------------------------------------------------

function m(
  id: string,
  contextWindow: number,
  maxTokens: number,
  extra: Partial<ModelConfig> = {},
): ModelConfig {
  return { id, contextWindow, maxTokens, input: ["text"], ...extra };
}

const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    api: "anthropic-messages",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "${ANTHROPIC_API_KEY}",
    models: [
      m("claude-sonnet-4-5", 200_000, 64_000, { input: ["text", "image"], cost: { input: 3, output: 15 } }),
      m("claude-haiku-4-5", 200_000, 64_000, { input: ["text", "image"], cost: { input: 1, output: 5 } }),
      m("claude-opus-4-1", 200_000, 32_000, { input: ["text", "image"], cost: { input: 15, output: 75 } }),
    ],
  },
  openai: {
    api: "openai-completions",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "${OPENAI_API_KEY}",
    compat: { maxTokensField: "max_completion_tokens" },
    models: [
      m("gpt-5.1", 400_000, 128_000, { cost: { input: 1.25, output: 10 } }),
      m("gpt-5", 400_000, 128_000, { cost: { input: 1.25, output: 10 } }),
      m("gpt-4.1", 1_000_000, 32_768, { cost: { input: 2, output: 8 } }),
      m("gpt-4o", 128_000, 16_384, { input: ["text", "image"], cost: { input: 2.5, output: 10 } }),
    ],
  },
  zhipu: {
    api: "openai-completions",
    name: "Zhipu (GLM)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "${ZHIPU_API_KEY}",
    models: [
      m("glm-5.3-flash", 200_000, 128_000, { cost: { input: 0.6, output: 2.2 } }),
      m("glm-5.3", 200_000, 128_000, { cost: { input: 0.6, output: 2.2 } }),
      m("glm-4.6", 200_000, 128_000, { cost: { input: 0.6, output: 2.2 } }),
      m("glm-4.5", 128_000, 96_000, { cost: { input: 0.6, output: 2.2 } }),
      m("glm-4.5-air", 128_000, 96_000, { cost: { input: 0.2, output: 0.8 } }),
    ],
  },
  deepseek: {
    api: "openai-completions",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "${DEEPSEEK_API_KEY}",
    models: [
      m("deepseek-chat", 128_000, 8_192, { cost: { input: 0.27, output: 1.1 } }),
      m("deepseek-reasoner", 128_000, 64_000, { cost: { input: 0.55, output: 2.19 } }),
    ],
  },
  moonshot: {
    api: "openai-completions",
    name: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKey: "${MOONSHOT_API_KEY}",
    models: [
      m("kimi-k2-0905-preview", 256_000, 16_384, { cost: { input: 0.6, output: 2.5 } }),
      m("kimi-k2-turbo-preview", 256_000, 16_384, { cost: { input: 1.15, output: 8 } }),
    ],
  },
  dashscope: {
    api: "openai-completions",
    name: "Alibaba (Qwen)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "${DASHSCOPE_API_KEY}",
    models: [
      m("qwen3-coder-plus", 1_000_000, 65_536),
      m("qwen-max", 131_072, 8_192),
    ],
  },
  openrouter: {
    api: "openai-completions",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "${OPENROUTER_API_KEY}",
    models: [
      m("anthropic/claude-sonnet-4.5", 200_000, 64_000),
      m("openai/gpt-5.1", 400_000, 128_000),
    ],
  },
  google: {
    api: "openai-completions",
    name: "Google (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "${GEMINI_API_KEY}",
    models: [
      m("gemini-2.5-pro", 1_048_576, 65_536, { input: ["text", "image"] }),
      m("gemini-2.5-flash", 1_048_576, 65_536, { input: ["text", "image"] }),
    ],
  },
  ollama: {
    api: "openai-completions",
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    models: [],
  },
};

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

const valueCache = new Map<string, string>();

/** Resolve "${ENV}"/"$ENV", "!command" and "$$"/"$!" escapes. */
export function resolveValue(raw: string | undefined, warn?: (msg: string) => void): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw.startsWith("$$") || raw.startsWith("$!")) return raw.slice(1);
  if (raw.startsWith("!")) {
    const cmd = raw.slice(1);
    if (valueCache.has(`!${cmd}`)) return valueCache.get(`!${cmd}`);
    try {
      const out = execFileSync(cmd, { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      valueCache.set(`!${cmd}`, out);
      return out;
    } catch (err) {
      warn?.(`command failed while resolving "!${cmd}": ${(err as Error).message}`);
      return undefined;
    }
  }
  const envRef = raw.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (envRef) {
    const name = envRef[1] ?? envRef[2]!;
    const value = process.env[name];
    if (value === undefined || value === "") {
      warn?.(`environment variable ${name} is not set`);
      return undefined;
    }
    return value;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Config loading & merging
// ---------------------------------------------------------------------------

export function loadUserConfig(path = CONFIG_PATH): { config: WCodeConfig; path: string } {
  let raw: string | undefined;
  const candidate = process.env.WCODE_CONFIG ?? path;
  if (existsSync(candidate)) {
    raw = readFileSync(candidate, "utf8");
  }
  const config: WCodeConfig = { providers: {} };
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripComments(raw));
    } catch (err) {
      throw new Error(`failed to parse config at ${candidate}: ${(err as Error).message}`);
    }
    const obj = parsed as WCodeConfig;
    config.defaultModel = typeof obj.defaultModel === "string" ? obj.defaultModel : undefined;
    config.providers = obj.providers ?? {};
  }
  return { config, path: candidate };
}

/** Allow // and /* *\/ comments in the user's config for convenience. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < src.length) out += src[++i]!;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Field-wise merge of a built-in provider with its user config entry. */
function mergeProvider(builtin: ProviderConfig | undefined, user: Partial<ProviderConfig>): ProviderConfig {
  const base: ProviderConfig = builtin
    ? { ...builtin, models: [...builtin.models], headers: { ...(builtin.headers ?? {}) } }
    : { api: user.api ?? "openai-completions", name: user.name, baseUrl: "", models: [] };
  const merged: ProviderConfig = {
    ...base,
    ...user,
    name: user.name ?? base.name,
    models: user.models === undefined ? base.models : [...user.models],
  };
  // Upsert user models into the (kept) built-in list by id — user entry wins.
  if (builtin && user.models !== undefined && user.models.length > 0) {
    const byId = new Map(merged.models.map((mo) => [mo.id, mo]));
    for (const um of user.models) byId.set(um.id, { ...byId.get(um.id), ...um });
    merged.models = [...byId.values()];
  }
  return merged;
}

export interface ProviderRegistry {
  config: WCodeConfig;
  configPath: string;
  /** providerId -> merged provider config. */
  providers: Record<string, ProviderConfig>;
}

export function loadRegistry(): ProviderRegistry {
  const { config, path } = loadUserConfig();
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, builtin] of Object.entries(BUILTIN_PROVIDERS)) {
    providers[id] = mergeProvider(builtin, config.providers[id] ?? {});
  }
  for (const [id, user] of Object.entries(config.providers)) {
    if (!providers[id]) providers[id] = mergeProvider(undefined, user);
  }
  return { config, configPath: path, providers };
}

const warnNoop = (_msg: string) => {};

export interface ModelEntry {
  key: string; // "provider/modelId"
  providerId: string;
  provider: ProviderConfig;
  model: ModelConfig;
  available: boolean;
}

/** Every configured model, flagged by whether its API key resolves. */
export function listModels(registry: ProviderRegistry): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const [providerId, provider] of Object.entries(registry.providers)) {
    for (const model of provider.models) {
      const apiKey = resolveValue(provider.apiKey, warnNoop);
      entries.push({
        key: `${providerId}/${model.id}`,
        providerId,
        provider,
        model,
        available: apiKey !== undefined || provider.api === "ollama",
      });
    }
  }
  return entries;
}

export function resolveModel(registry: ProviderRegistry, selector?: string): ResolvedModel {
  const selector0 = selector ?? registry.config.defaultModel ?? autoDetect(registry);
  if (!selector0) {
    throw new Error(noModelError());
  }
  const [providerId, modelId] = splitSelector(selector0);
  const provider = registry.providers[providerId];
  if (!provider) {
    throw new Error(`unknown provider "${providerId}" (selector: ${selector0}). Known: ${Object.keys(registry.providers).join(", ")}`);
  }
  const model = provider.models.find((mo) => mo.id === modelId);
  if (!model) {
    throw new Error(
      `provider "${providerId}" has no model "${modelId}". Configured: ${provider.models.map((mo) => mo.id).join(", ") || "(none)"}`,
    );
  }
  const apiKey = resolveValue(provider.apiKey);
  if (apiKey === undefined && provider.api !== "ollama") {
    throw new Error(
      `no API key for provider "${providerId}". Set it in ${registry.configPath} ` +
        `(providers.${providerId}.apiKey) or via its environment variable.`,
    );
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(provider.headers ?? {})) {
    const resolved = resolveValue(v);
    if (resolved !== undefined) headers[k] = resolved;
  }
  return {
    key: `${providerId}/${model.id}`,
    providerId,
    provider,
    model,
    apiKey,
    headers,
  };
}

function splitSelector(selector: string): [string, string] {
  const idx = selector.indexOf("/");
  if (idx === -1) throw new Error(`model selector must look like "provider/model", got "${selector}"`);
  return [selector.slice(0, idx), selector.slice(idx + 1)];
}

/** Pick the first provider whose API key is present and that has models. */
function autoDetect(registry: ProviderRegistry): string | undefined {
  for (const [id, provider] of Object.entries(registry.providers)) {
    if (provider.models.length === 0) continue;
    if (resolveValue(provider.apiKey, warnNoop) !== undefined) {
      return `${id}/${provider.models[0]!.id}`;
    }
  }
  return undefined;
}

function noModelError(): string {
  return [
    "no model configured.",
    "",
    "Fix: create ~/.wcode/config.json with at least one provider, e.g.",
    "",
    "  {",
    '    "providers": {',
    '      "zhipu": {',
    '        "api": "openai-completions",',
    '        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",',
    '        "apiKey": "${ZHIPU_API_KEY}",',
    '        "models": [{ "id": "glm-4.6" }]',
    "      }",
    "    },",
    '    "defaultModel": "zhipu/glm-4.6"',
    "  }",
    "",
    "Or export one of the supported vendor keys (ANTHROPIC_API_KEY, OPENAI_API_KEY,",
    "DEEPSEEK_API_KEY, MOONSHOT_API_KEY, DASHSCOPE_API_KEY, GEMINI_API_KEY, ...).",
    "Run `wcode models` to see everything available.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Small helpers used by CLI commands
// ---------------------------------------------------------------------------

export function ensureDirs(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

/** Persist an API key for a provider (creates config if missing). */
export function saveProviderApiKey(providerId: string, apiKey: string): string {
  let config: WCodeConfig = { providers: {} };
  if (existsSync(CONFIG_PATH)) {
    config = loadUserConfig().config;
  }
  config.providers = { ...config.providers };
  const existing = config.providers[providerId] ?? {};
  config.providers[providerId] = { ...existing, apiKey };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return CONFIG_PATH;
}

export function defaultModelPath(): string {
  return resolve(process.cwd());
}
