// Set required env vars BEFORE importing the server module so that any
// future top-level reads still see them. The server now reads env at
// call-site, but we keep these here as a safety net for future changes.
process.env.FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || 'test-key';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createServer, createHttpApp } from './server.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

interface StartedServer {
  url: string;
  close: () => Promise<void>;
}

async function startApp(bearer?: string): Promise<StartedServer> {
  if (bearer === undefined) {
    delete process.env.MCP_BEARER;
  } else {
    process.env.MCP_BEARER = bearer;
  }
  const app = createHttpApp();
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}

const initBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
};

// ─── Tests ──────────────────────────────────────────────────────────────────

test('createServer factory still wires sampling capability', () => {
  const mcp = createServer();
  // `sampling` is a client capability in MCP — the server invokes
  // `server.createMessage(...)` (via MCPSamplingProvider) to ask the
  // connected client for an LLM completion. So the wiring we verify
  // here is:
  //   1. The underlying SDK Server exposes `createMessage` (the method
  //      MCPSamplingProvider calls to forward sampling requests).
  //   2. All sampling-dependent tools (enrich_email, enrich_rows,
  //      generate_fields) are registered.
  //   3. `tools` capability is declared.
  const inner = mcp.server as unknown as {
    _capabilities: Record<string, unknown>;
    createMessage: unknown;
  };
  assert.equal(typeof inner.createMessage, 'function', 'expected server.createMessage for sampling forwarding');

  const caps = inner._capabilities;
  assert.ok(caps, 'expected capabilities object on server');
  assert.ok('tools' in caps, 'expected "tools" capability to be declared');

  const registered = (mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  assert.ok(registered, 'expected _registeredTools map');
  for (const name of ['enrich_email', 'enrich_rows', 'generate_fields', 'firecrawl_search', 'firecrawl_scrape']) {
    assert.ok(name in registered, `expected tool "${name}" to be registered`);
  }
});

test('HTTP rejects missing Authorization when MCP_BEARER is set', async () => {
  const srv = await startApp('s3cr3t');
  try {
    const res = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(initBody),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /Bearer realm="fire-enrich"/);
  } finally {
    await srv.close();
  }
});

test('HTTP rejects mismatched bearer', async () => {
  const srv = await startApp('s3cr3t');
  try {
    const res = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify(initBody),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /Bearer realm="fire-enrich"/);
  } finally {
    await srv.close();
  }
});

test('HTTP accepts initialize with correct bearer and returns mcp-session-id', async () => {
  const srv = await startApp('s3cr3t');
  try {
    const res = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer s3cr3t',
      },
      body: JSON.stringify(initBody),
    });
    assert.equal(res.status, 200);
    const sessionId = res.headers.get('mcp-session-id');
    assert.ok(sessionId, 'expected Mcp-Session-Id response header');
    // Drain the response so the underlying socket can close cleanly.
    await res.text().catch(() => undefined);
  } finally {
    await srv.close();
  }
});

test('GET /health returns 200 regardless of bearer', async () => {
  const srv = await startApp('s3cr3t');
  try {
    const res = await fetch(`${srv.url}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; service: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'fire-enrich-mcp');
  } finally {
    await srv.close();
  }
});
