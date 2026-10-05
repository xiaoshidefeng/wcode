#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Prefer the compiled output; fall back to tsx for checkouts without a build.
const distEntry = join(here, "..", "dist", "cli.js");
const srcEntry = join(here, "..", "src", "cli.ts");

if (existsSync(distEntry)) {
  await import(distEntry);
} else {
  const require = createRequire(import.meta.url);
  let tsx;
  try {
    tsx = require.resolve("tsx/cli");
  } catch {
    console.error("wcode is not built. Run `npm run build` (or `npm install` first).");
    process.exit(1);
  }
  process.argv.splice(1, 1, srcEntry);
  await import(tsx);
}
