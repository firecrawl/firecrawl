#!/usr/bin/env node
// Patches firecrawl-fastmcp to strip $schema from tool inputSchema.
// Zod v4 outputs JSON Schema 2020-12 with $schema, which many MCP clients
// (using AJV draft-07) reject. Stripping $schema makes schemas client-agnostic.
// See: https://github.com/mastra-ai/mastra/issues/14523

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = resolve(__dirname, '../node_modules/firecrawl-fastmcp/dist/FastMCP.js');

let src = readFileSync(target, 'utf-8');

const before = 'inputSchema: tool.parameters ? await toJsonSchema(tool.parameters) : {';
const after = 'inputSchema: tool.parameters ? (({ $schema, ...rest }) => rest)(await toJsonSchema(tool.parameters)) : {';

if (src.includes(after)) {
  console.log('[patch-schema] Already patched — skipping.');
  process.exit(0);
}

if (!src.includes(before)) {
  console.error('[patch-schema] Could not find target line in FastMCP.js — firecrawl-fastmcp may have been updated.');
  process.exit(1);
}

src = src.replace(before, after);
writeFileSync(target, src);
console.log('[patch-schema] Stripped $schema from tool inputSchema (JSON Schema 2020-12 compat fix).');
