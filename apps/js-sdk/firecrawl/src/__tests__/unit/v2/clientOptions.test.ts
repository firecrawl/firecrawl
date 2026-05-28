import { Firecrawl, FirecrawlClient, type FirecrawlClientOptions } from '../../../index';

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

  it('should accept a string API key in Firecrawl constructor', () => {
    const client = new Firecrawl('test-key');

    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(Firecrawl);
  });

  it('should accept a string API key in FirecrawlClient constructor', () => {
    const client = new FirecrawlClient('test-key');

    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(FirecrawlClient);
  });

  it('should throw for empty string API key on cloud', () => {
    expect(() => new Firecrawl('')).toThrow('API key is required');
  });

  it('should throw for whitespace-only string API key on cloud', () => {
    expect(() => new Firecrawl('   ')).toThrow('API key is required');
  });

  it('should provide v1 accessor when constructed with string', () => {
    const client = new Firecrawl('test-key');

    expect(client.v1).toBeDefined();
  });
});
