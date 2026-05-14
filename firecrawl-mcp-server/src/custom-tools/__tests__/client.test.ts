import { jest, describe, it, expect, afterEach } from '@jest/globals';

// Mock FirecrawlApp before importing createClient
const mockFirecrawlInstance = { apiKey: 'test', apiUrl: 'test' };
jest.unstable_mockModule('@mendable/firecrawl-js', () => ({
  __esModule: true,
  default: jest.fn(() => mockFirecrawlInstance),
}));

const { createClient } = await import('../client.js');

describe('createClient', () => {
  const originalEnv = process.env.FIRECRAWL_API_URL;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.FIRECRAWL_API_URL = originalEnv;
    } else {
      delete process.env.FIRECRAWL_API_URL;
    }
  });

  it('creates client with FIRECRAWL_API_URL from env', () => {
    process.env.FIRECRAWL_API_URL = 'http://localhost:3002';
    const client = createClient();
    expect(client).toBeDefined();
  });

  it('creates client with session API key', () => {
    delete process.env.FIRECRAWL_API_URL;
    const client = createClient({ firecrawlApiKey: 'test-key' });
    expect(client).toBeDefined();
  });

  it('throws if neither FIRECRAWL_API_URL nor session key is provided', () => {
    delete process.env.FIRECRAWL_API_URL;
    expect(() => createClient()).toThrow('FIRECRAWL_API_URL environment variable is not set');
  });

  it('throws if env is unset and session has no key', () => {
    delete process.env.FIRECRAWL_API_URL;
    expect(() => createClient({})).toThrow('FIRECRAWL_API_URL environment variable is not set');
  });
});
