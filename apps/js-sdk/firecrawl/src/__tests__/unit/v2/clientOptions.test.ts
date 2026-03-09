import { Firecrawl, FirecrawlAppV1, type FirecrawlClientOptions } from '../../../index';

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
});
