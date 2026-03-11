import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Firecrawl, FirecrawlAppV1, type FirecrawlClientOptions } from '../../../index';

async function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server address');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopTestServer(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

describe('Firecrawl v2 Client Options', () => {
  it('should accept v2 options including timeoutMs, maxRetries, and backoffFactor', () => {
    const options: FirecrawlClientOptions = {
      apiKey: 'test-key',
      timeoutMs: 300,
      maxRetries: 5,
      backoffFactor: 0.5,
    };

    // Should not throw any type errors
    const client = new Firecrawl(options);
    
    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(Firecrawl);
  });

  it('should work with minimal options', () => {
    const options: FirecrawlClientOptions = {
      apiKey: 'test-key',
    };

    const client = new Firecrawl(options);
    
    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(Firecrawl);
  });

  it('should work with all v2 options', () => {
    const options: FirecrawlClientOptions = {
      apiKey: 'test-key',
      apiUrl: 'https://custom-api.firecrawl.dev',
      timeoutMs: 60000,
      maxRetries: 3,
      backoffFactor: 1.0,
    };

    const client = new Firecrawl(options);
    
    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(Firecrawl);
  });

  it('should export FirecrawlClientOptions type', () => {
    // This test ensures the type is properly exported
    const options: FirecrawlClientOptions = {
      apiKey: 'test-key',
      timeoutMs: 300,
    };

    expect(options.timeoutMs).toBe(300);
    expect(options.apiKey).toBe('test-key');
  });

  it('should allow self-hosted v2 usage without an API key and omit auth headers', () => {
    const client = new Firecrawl({
      apiUrl: 'http://localhost:3002',
    });

    const transport = (client as any).http;
    const defaults = transport.instance.defaults.headers;

    expect(transport.getApiKey()).toBe('');
    expect(defaults.Authorization).toBeUndefined();
  });

  it('should allow self-hosted v1 usage without an API key and omit auth headers', () => {
    const client = new FirecrawlAppV1({
      apiUrl: 'http://localhost:3002',
    });

    const headers = client.prepareHeaders();

    expect(client.apiKey).toBe('');
    expect(headers.Authorization).toBeUndefined();
  });

  it('should reject whitespace-only API keys for the cloud v1 client', () => {
    expect(
      () =>
        new FirecrawlAppV1({
          apiKey: '   ',
          apiUrl: 'https://api.firecrawl.dev',
        })
    ).toThrow('No API key provided');
  });

  it('should reject non-string API keys for the cloud v1 client without throwing a TypeError', () => {
    expect(
      () =>
        new FirecrawlAppV1({
          apiKey: 42 as any,
          apiUrl: 'https://api.firecrawl.dev',
        }),
    ).toThrow('No API key provided');
  });

  it('should reject non-string API keys for the cloud v2 client without throwing a TypeError', () => {
    expect(
      () =>
        new Firecrawl({
          apiKey: { token: 'abc' } as any,
          apiUrl: 'https://api.firecrawl.dev',
        }),
    ).toThrow('API key is required for the cloud API');
  });

  it('should not send an Authorization header to self-hosted v2 scrape endpoints', async () => {
    let seenAuthorization: string | string[] | undefined;
    let seenOrigin: unknown;
    const { server, baseUrl } = await startTestServer((req, res) => {
      seenAuthorization = req.headers.authorization;
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        seenOrigin = JSON.parse(body).origin;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { markdown: '# ok' } }));
      });
    });

    try {
      const client = new Firecrawl({
        apiUrl: baseUrl,
        maxRetries: 1,
      });

      const result = await client.scrape('https://example.com');

      expect(result.markdown).toBe('# ok');
      expect(seenAuthorization).toBeUndefined();
      expect(typeof seenOrigin).toBe('string');
      expect(String(seenOrigin)).toContain('js-sdk@');
    } finally {
      await stopTestServer(server);
    }
  });

  it('should not send an Authorization header to self-hosted v1 scrape endpoints', async () => {
    let seenAuthorization: string | string[] | undefined;
    let requestPath: string | undefined;
    const { server, baseUrl } = await startTestServer((req, res) => {
      seenAuthorization = req.headers.authorization;
      requestPath = req.url || undefined;
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            data: { markdown: '# ok', metadata: { sourceURL: 'https://example.com' } },
          })
        );
      });
    });

    try {
      const client = new FirecrawlAppV1({
        apiUrl: baseUrl,
      });

      const result = await client.scrapeUrl('https://example.com', {});

      expect(result.success).toBe(true);
      expect(seenAuthorization).toBeUndefined();
      expect(requestPath).toBe('/v1/scrape');
    } finally {
      await stopTestServer(server);
    }
  });
});
