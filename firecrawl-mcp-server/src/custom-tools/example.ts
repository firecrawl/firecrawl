// src/custom-tools/example.ts
// TEMPLATE — copy this file to create a new custom tool.
//
// Rules for all custom tools:
// 1. Export a register(server: MCP) function — never call server.addTool() at module level.
// 2. All local imports use .js extension (NodeNext module resolution).
// 3. Tool name prefix: firecrawl_ (matches stock tool naming convention).
// 4. Return a plain string from execute() — use JSON.stringify() for structured data.
// 5. Never hardcode secrets, API keys, or URLs. Use process.env.* only.
// 6. For tools that call Firecrawl APIs: import FirecrawlApp and instantiate via
//    createClient() pattern — see src/index.ts for the pattern to replicate.
//
// To use this template for a new tool (e.g., firecrawl_research):
//   cp src/custom-tools/example.ts src/custom-tools/research.ts
//   - Rename the function (registerExample → registerResearch)
//   - Change name to 'firecrawl_research'
//   - Update description and parameters
//   - Implement execute() logic
//   - Add to src/custom-tools/index.ts barrel

import { z } from 'zod';
import type { MCP } from './types.js';

/**
 * Registers the firecrawl_example tool.
 * This echo tool validates the entire registration pipeline:
 * types → example → index barrel → index.ts addTool → MCP tool list.
 */
export function register(server: MCP): void {
  server.addTool({
    name: 'firecrawl_example',
    description:
      'Example custom tool — confirms the custom tool registration framework works. ' +
      'Echoes the input message back with framework metadata. ' +
      'Remove or replace this tool once Story 2.1 is verified.',
    parameters: z.object({
      message: z.string().describe('A test message to echo back'),
    }),
    execute: async (args) => {
      const { message } = args as { message: string };
      return JSON.stringify(
        {
          echo: message,
          framework: 'custom-tool-registration-framework',
          story: '2.1',
          status: 'ok',
        },
        null,
        2
      );
    },
  });
}
