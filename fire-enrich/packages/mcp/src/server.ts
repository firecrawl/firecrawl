import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  FirecrawlService,
  EnrichmentStrategy,
  generateFields,
  searchWeb,
  scrapeUrl,
  type EnrichmentField,
} from '@fire-enrich/core';
import { MCPSamplingProvider } from '@fire-enrich/core/mcp';
import { enrichRows } from '@fire-enrich/core/server';

function requireFirecrawlApiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY ?? '';
  if (!key) {
    console.error('[fire-enrich-mcp] FIRECRAWL_API_KEY is required');
    process.exit(1);
  }
  return key;
}

// MCP_BEARER startup gate (Phase 10) — stdio only.
//
// Stdio transport has no per-request Authorization header, so the only
// place to enforce auth is at process start. If MCP_BEARER is set the
// launcher's env must include a matching FIRE_ENRICH_BEARER, otherwise
// we exit 1 before the server accepts a single message.
//
// In HTTP mode this gate is replaced by per-request bearer enforcement
// (see `bearerMiddleware` below) so we do NOT call this function from
// `startHttpServer`.
function enforceStdioBearerGate(): void {
  const MCP_BEARER = process.env.MCP_BEARER;
  if (!MCP_BEARER) return;
  const provided = process.env.FIRE_ENRICH_BEARER ?? '';
  const a = Buffer.from(MCP_BEARER);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.error(
      '[fire-enrich-mcp] MCP_BEARER set but FIRE_ENRICH_BEARER missing or does not match',
    );
    process.exit(1);
  }
}

export function createServer(): McpServer {
  const apiKey = requireFirecrawlApiKey();
  const server = new McpServer({
    name: 'fire-enrich',
    version: '0.1.0',
  }, {
    // `sampling` is a CLIENT capability in the MCP spec; the server
    // requests sampling FROM the client at runtime via
    // `MCPSamplingProvider` -> `server.createMessage(...)`. So the
    // server only declares `tools` here; the sampling round-trip is
    // forwarding logic in the tool handlers below — which is the whole
    // reason this MCP server exists. Don't accidentally drop the
    // `MCPSamplingProvider` instantiation when refactoring transports.
    capabilities: { tools: {} },
  });

  const firecrawl = new FirecrawlService(apiKey);

  const EnrichmentFieldSchema = z.object({
    name: z.string(),
    displayName: z.string(),
    description: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'array']),
    required: z.boolean(),
  });

  const CSVRowSchema = z.record(z.string(), z.string());

  server.tool(
    'enrich_email',
    'Enrich a single email address with specified fields using web research',
    {
      email: z.string().describe('Email address to enrich'),
      fields: z.array(EnrichmentFieldSchema).describe('Fields to extract'),
      name: z.string().optional().describe('Known name of the person'),
    },
    async (args) => {
      const provider = new MCPSamplingProvider(server.server);
      const strategy = new EnrichmentStrategy({ firecrawlApiKey: apiKey, llmProvider: provider });
      const row: Record<string, string> = { email: args.email };
      if (args.name) row._name = args.name;
      const enrichments = await strategy.enrichRow(row, args.fields as EnrichmentField[]);
      return { content: [{ type: 'text', text: JSON.stringify({ email: args.email, enrichments }, null, 2) }] };
    }
  );

  server.tool(
    'enrich_rows',
    'Enrich multiple CSV rows with specified fields. Emits progress notifications per row.',
    {
      rows: z.array(CSVRowSchema).describe('CSV rows to enrich'),
      fields: z.array(EnrichmentFieldSchema).describe('Fields to extract'),
      emailColumn: z.string().describe('Column name containing email addresses'),
      nameColumn: z.string().optional().describe('Column name containing person names'),
    },
    async (args) => {
      const provider = new MCPSamplingProvider(server.server);
      const results = await enrichRows({
        rows: args.rows,
        fields: args.fields as EnrichmentField[],
        emailColumn: args.emailColumn,
        nameColumn: args.nameColumn,
        llmProvider: provider,
        firecrawlApiKey: apiKey,
      });
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'generate_fields',
    'Generate enrichment field definitions from a natural language description',
    {
      prompt: z.string().describe('Natural language description of what data to collect'),
    },
    async (args) => {
      const provider = new MCPSamplingProvider(server.server);
      const result = await generateFields({ prompt: args.prompt, llmProvider: provider });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'firecrawl_search',
    'Search the web using Firecrawl and return results with content',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().describe('Maximum number of results (default: 5)'),
      scrapeContent: z.boolean().optional().describe('Include page content in results (default: true)'),
    },
    async (args) => {
      const results = await searchWeb({ query: args.query, limit: args.limit, scrapeContent: args.scrapeContent, firecrawl });
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'firecrawl_scrape',
    'Scrape a single URL and return its content as markdown',
    {
      url: z.string().url().describe('URL to scrape'),
    },
    async (args) => {
      const result = await scrapeUrl({ url: args.url, firecrawl });
      return { content: [{ type: 'text', text: result.markdown ?? result.error ?? '' }] };
    }
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  requireFirecrawlApiKey();
  enforceStdioBearerGate();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[fire-enrich-mcp] Server started on stdio');
}

// ─── HTTP transport ─────────────────────────────────────────────────────────

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

/**
 * Constant-time bearer comparison. Returns true only if `provided` matches
 * `expected` byte-for-byte. Length-mismatch returns false without leaking
 * timing information about which prefix matched.
 */
function bearerMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Express middleware that enforces `Authorization: Bearer <MCP_BEARER>` on
 * every request when MCP_BEARER is set. Replaces the stdio startup gate
 * with per-request enforcement so a single misconfigured proxy can't
 * silently disable auth for an entire session.
 */
export function bearerMiddleware(expectedBearer: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!expectedBearer) {
      next();
      return;
    }
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="fire-enrich"');
      res.status(401).json({ error: 'Missing or malformed Authorization header' });
      return;
    }
    const provided = header.slice('Bearer '.length).trim();
    if (!bearerMatches(expectedBearer, provided)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="fire-enrich"');
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }
    next();
  };
}

/**
 * Build the Express app for HTTP transport. Exported separately from
 * `startHttpServer` so tests can mount it on an ephemeral port without
 * touching MCP_PORT/MCP_HOST.
 */
export function createHttpApp(): Express {
  const app = express();
  app.use(express.json());

  const expectedBearer = process.env.MCP_BEARER;
  const sessions = new Map<string, SessionEntry>();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'fire-enrich-mcp' });
  });

  // Bearer auth applies to /mcp only — /health stays unauthenticated so
  // load balancers and orchestrators can probe liveness.
  const auth = bearerMiddleware(expectedBearer);

  app.post('/mcp', auth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Existing session: route to its transport.
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found or expired' });
        return;
      }
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session: must be an MCP initialize request.
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({ error: 'First request must be MCP initialize' });
      return;
    }

    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    });

    transport.onclose = () => {
      sessions.delete(newSessionId);
    };

    const server = createServer();
    await server.connect(transport);
    sessions.set(newSessionId, { server, transport });

    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', auth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing Mcp-Session-Id header for SSE stream' });
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }
    await session.transport.handleRequest(req, res);
  });

  app.delete('/mcp', auth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        await session.transport.close();
        sessions.delete(sessionId);
      }
    }
    res.status(200).json({ ok: true });
  });

  return app;
}

export async function startHttpServer(): Promise<HttpServer> {
  requireFirecrawlApiKey();
  const port = Number(process.env.MCP_PORT ?? '8080');
  const host = process.env.MCP_HOST ?? '0.0.0.0';
  const app = createHttpApp();
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.error(`[fire-enrich-mcp] Server started on http://${host}:${port}`);
  return server;
}
