// /api/admin/ops/mcp/status
// Probes MCP /health + tools/list in one shot. Returned together so the
// dashboard can render both without flipping the loading state twice.

import { adminGuard } from '@/lib/ops/admin-guard';
import { mcpBackendUrl } from '@/lib/ops/probe';

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpStatusResponse {
  configured: boolean;
  health: {
    status: 'up' | 'down' | 'unknown';
    latencyMs: number | null;
    message: string | null;
  };
  tools: ToolDefinition[];
  toolListError?: string;
  generatedAt: string;
}

export async function GET(req: Request): Promise<Response> {
  const denied = adminGuard(req);
  if (denied) return denied;

  const base = mcpBackendUrl();
  if (!base) {
    return Response.json({
      configured: false,
      health: { status: 'unknown', latencyMs: null, message: 'MCP_INTERNAL_URL is not set.' },
      tools: [],
      generatedAt: new Date().toISOString(),
    } satisfies McpStatusResponse);
  }

  const startedAt = performance.now();
  let health: McpStatusResponse['health'];
  try {
    const res = await fetch(`${base}/health`, { cache: 'no-store' });
    const latencyMs = Math.round(performance.now() - startedAt);
    if (!res.ok) {
      const body = await res.text();
      health = {
        status: 'down',
        latencyMs,
        message: `HTTP ${res.status} ${body.slice(0, 120)}`,
      };
    } else {
      const body = await res.text();
      health = { status: 'up', latencyMs, message: body.slice(0, 120) || 'ok' };
    }
  } catch (err) {
    health = {
      status: 'down',
      latencyMs: Math.round(performance.now() - startedAt),
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let tools: ToolDefinition[] = [];
  let toolListError: string | undefined;

  if (health.status === 'up') {
    try {
      tools = await listTools(base);
    } catch (err) {
      toolListError = err instanceof Error ? err.message : String(err);
    }
  }

  return Response.json({
    configured: true,
    health,
    tools,
    ...(toolListError ? { toolListError } : {}),
    generatedAt: new Date().toISOString(),
  } satisfies McpStatusResponse);
}

/**
 * Speak JSON-RPC over the MCP stream-HTTP transport. We do an `initialize`
 * + `tools/list` round-trip on the same SSE stream, parse the second frame,
 * and bail. FastMCP returns text/event-stream when accept-header asks for it.
 */
async function listTools(base: string): Promise<ToolDefinition[]> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'fire-enrich-ops', version: '0' },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`initialize HTTP ${res.status}`);
  }

  // Some FastMCP setups need a fresh request per JSON-RPC call; others reuse
  // the same session id from a header. Try the simple path first.
  const sessionHeader = res.headers.get('mcp-session-id') ?? undefined;

  // Drain initialize response so the server is ready for the next call.
  await consumeSseOrJson(res);

  // notifications/initialized
  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionHeader ? { 'mcp-session-id': sessionHeader } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });

  // tools/list
  const listRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionHeader ? { 'mcp-session-id': sessionHeader } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    }),
  });
  if (!listRes.ok) {
    throw new Error(`tools/list HTTP ${listRes.status}`);
  }

  const payload = await consumeSseOrJson(listRes);
  const tools = (payload?.result as { tools?: ToolDefinition[] } | undefined)?.tools;
  if (!Array.isArray(tools)) {
    throw new Error('tools/list response missing result.tools array');
  }
  return tools;
}

/** Read the body as either application/json or text/event-stream and return the last "data:" frame as JSON. */
async function consumeSseOrJson(res: Response): Promise<{ result?: unknown }> {
  const ct = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (ct.includes('application/json')) {
    return JSON.parse(text);
  }
  // SSE: pick the last "data:" line that parses as JSON.
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      continue;
    }
  }
  // Some servers stream the JSON without an event prefix.
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
