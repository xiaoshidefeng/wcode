// Web tools: fetch a page and turn it into plain text, and a best-effort web
// search. Both are read-only (usable in plan mode) and dependency-free.
//
// webfetch returns the page text (or JSON verbatim); the model does the
// extraction itself. websearch scrapes DuckDuckGo's HTML endpoint — errors
// surface as tool errors and the model falls back to webfetch or local work.

import type { Tool, ToolContext, ToolOutput } from "./types.js";
import { ToolError, str } from "./types.js";
import { truncateOutput } from "./util.js";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 3_000_000;
const UA = "Mozilla/5.0 (X11; Linux x86_64) wcode-agent/0.2";

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", middot: "·",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** Strip scripts/styles/tags and collapse whitespace into readable text. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function assertHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ToolError(`only http/https URLs are supported, got ${parsed.protocol}`);
  }
  return parsed;
}

async function fetchBody(url: string, signal: AbortSignal): Promise<{ text: string; contentType: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal,
      headers: { "user-agent": UA, accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" },
    });
  } catch (err) {
    throw new ToolError(`request failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new ToolError(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const contentType = res.headers.get("content-type") ?? "";
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new ToolError(`response too large (${Math.round(buffer.byteLength / 1e6)}MB); fetch a more specific URL`);
  }
  return { text: new TextDecoder("utf-8").decode(buffer), contentType };
}

// ---------------------------------------------------------------------------
// webfetch
// ---------------------------------------------------------------------------

export function createWebFetchTool(): Tool {
  return {
    name: "webfetch",
    description: `Fetch a URL and return its content as plain text (HTML is converted, JSON/other text formats are returned as-is). Use for documentation pages, blog posts, raw files, API responses.

- Returns the page text; you read and extract from it. Large pages are truncated in the middle.
- The optional "prompt" records what to look for but is not applied automatically — read the result with that question in mind.
- Cannot execute JavaScript (no SPA rendering) and cannot log in to sites.`,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to fetch" },
        prompt: { type: "string", description: "What you are looking for in the page (advisory)" },
      },
      required: ["url"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      const url = assertHttpUrl(str(args, "url")).toString();
      const { text, contentType } = await fetchBody(url, ctx.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS));
      const isHtml = contentType.includes("text/html") || contentType.includes("xhtml");
      const body = isHtml ? htmlToText(text) : text.trim();
      if (body === "") throw new ToolError("page returned no readable content");
      const kept = truncateOutput(body, 20_000);
      return {
        content: [{ type: "text", text: kept }],
        display: `fetched ${new URL(url).host}`,
        detail: kept.split("\n").slice(0, 3).join("\n"),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// websearch
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Extract results from DuckDuckGo's html endpoint markup. */
export function parseDdgResults(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const blockRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]!);
  let i = 0;
  for (const match of html.matchAll(blockRe)) {
    const rawUrl = decodeEntities(match[1]!);
    const title = htmlToText(match[2]!);
    if (title === "") continue;
    // result links are redirects: //duckduckgo.com/l/?uddg=<encoded>&rut=...
    const uddg = rawUrl.match(/[?&]uddg=([^&]+)/);
    const url = uddg ? decodeURIComponent(uddg[1]!) : rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    out.push({ title, url, snippet: htmlToText(snippets[i] ?? "") });
    i++;
  }
  return out;
}

export function createWebSearchTool(): Tool {
  return {
    name: "websearch",
    description: `Search the web and return the top results (title, URL, snippet). Use to look up documentation, error messages, library versions, or anything outside this repository.

- Snippets only — follow up with webfetch on a promising URL to read the page.
- Requires network access; failures return an error, not a crash.`,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      const query = str(args, "query").trim();
      if (query === "") throw new ToolError("empty query");
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const { text } = await fetchBody(url, ctx.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS));
      const results = parseDdgResults(text).slice(0, 8);
      if (results.length === 0) throw new ToolError(`no results for "${query}" (the search engine may be rate-limiting; try webfetch instead)`);
      const body = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 200)}` : ""}`)
        .join("\n");
      return {
        content: [{ type: "text", text: truncateOutput(body, 8_000) }],
        display: `searched: ${query.length > 60 ? `${query.slice(0, 60)}…` : query} (${results.length} results)`,
      };
    },
  };
}
