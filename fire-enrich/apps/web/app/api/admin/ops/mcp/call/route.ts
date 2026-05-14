// /api/admin/ops/mcp/call
// One-shot proxy to the MCP server's tools/call JSON-RPC. Body shape:
//   { tool: string; args: Record<string, unknown> }
// Returns the unwrapped { content, isError } from the MCP response, or the
// raw JSON-RPC error.

import { adminGuard } from '@/lib/ops/admin-guard';
import { mcpBackendUrl } from '@/lib/ops/probe';

interface CallBody {
  tool: string;
  args?: Record<string, unknown>;
}

export async function POST(req: Request): Promise<Response> {
  const denied = adminGuard(req);
  if (denied) return denied;

  const base = mcpBackendUrl();
  if (!base) {
    return Response.json(
      {
        code: 'unconfigured',
        error: 'Set MCP_INTERNAL_URL to enable tool calls.',
      },
      { status: 503 },
    );
  }

  let body: CallBody;
  try {
    body = (await req.json()) as CallBody;
  } catch {
    return Response.json(
      { code: 'invalid_request', error: 'body must be JSON' },
      { status: 400 },
    );
  }
  if (!body.tool || typeof body.tool !== 'string') {
    return Response.json(
      { code: 'invalid_request', error: '`tool` is required' },
      { status: 400 },
    );
  }

  const startedAt = performance.now();
  try {
    const result = await callTool(base, body.tool, body.args ?? {});
    return Response.json({
      tool: body.tool,
      latencyMs: Math.round(performance.now() - startedAt),
      ...result,
    });
  } catch (err) {
    return Response.json(
      {
        tool: body.tool,
        latencyMs: Math.round(performance.now() - startedAt),
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}

async function callTool(base: string, name: string, args: Record<string, unknown>) {
  const initRes = await fetch(`${base}/mcp`, {
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
  if (!initRes.ok) throw new Error(`initialize HTTP ${initRes.status}`);
  const sessionHeader = initRes.headers.get('mcp-session-id') ?? undefined;
  await initRes.text();

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

  const callRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionHeader ? { 'mcp-session-id': sessionHeader } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!callRes.ok) throw new Error(`tools/call HTTP ${callRes.status}`);

  const text = await callRes.text();
  const ct = callRes.headers.get('content-type') ?? '';
  const payload = ct.includes('application/json')
    ? JSON.parse(text)
    : extractLastSseJson(text);

  if (payload.error) {
    return { error: String(payload.error.message ?? 'tool error'), rpcError: payload.error };
  }
  return { result: payload.result };
}

function extractLastSseJson(text: string): { result?: unknown; error?: { message?: string } } {
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
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: 'unparseable MCP response' } };
  }
}
