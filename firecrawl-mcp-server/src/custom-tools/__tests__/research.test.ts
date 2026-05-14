import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createMockClient, mockContext } from './helpers.js';

// Mock createClient before importing research
const mockClient = createMockClient();
jest.unstable_mockModule('../client.js', () => ({
  createClient: jest.fn(() => mockClient),
}));

const { safeSlice, formatOutput, register } = await import('../research.js');

describe('research — safeSlice', () => {
  it('returns content unchanged when under maxLen', () => {
    expect(safeSlice('short text', 100)).toBe('short text');
  });

  it('truncates at word boundary', () => {
    const long = 'word '.repeat(500);
    const result = safeSlice(long, 100);
    expect(result).toContain('*(content truncated');
  });

  it('handles content with no spaces gracefully', () => {
    const noSpaces = 'a'.repeat(200);
    const result = safeSlice(noSpaces, 50);
    expect(result).toContain('*(content truncated');
  });

  it('strips trailing high surrogates', () => {
    // 'hello world \uD83D' is 13 chars — at maxLen boundary, no truncation needed
    // Use a longer string that actually triggers truncation
    const withSurrogate = 'hello world some extra text here ' + '\uD83D';
    const result = safeSlice(withSurrogate, 20);
    expect(result).toContain('*(content truncated');
    expect(result).not.toMatch(/[\uD800-\uDBFF]\n/);
  });
});

describe('research — formatOutput', () => {
  it('formats successful sources with citations', () => {
    const result = formatOutput('test query', [
      { url: 'https://a.com', title: 'Source A', description: 'Desc A', content: 'Content A' },
      { url: 'https://b.com', title: 'Source B', description: 'Desc B', content: 'Content B' },
    ]);
    expect(result).toContain('# Research: test query');
    expect(result).toContain('**Sources found:** 2');
    expect(result).toContain('**Successfully scraped:** 2');
    expect(result).toContain('## Source 1: Source A');
    expect(result).toContain('*Citation: [Source A](https://a.com)*');
  });

  it('lists failed sources separately', () => {
    const result = formatOutput('test query', [
      { url: 'https://a.com', title: 'Source A', description: '', content: '', error: 'Scrape failed: timeout' },
    ]);
    expect(result).toContain('## Failed Sources');
    expect(result).toContain('Scrape failed: timeout');
    expect(result).toContain('**Successfully scraped:** 0');
  });

  it('shows message when all scrapes fail', () => {
    const result = formatOutput('q', [
      { url: 'https://x.com', title: 'X', description: '', content: '', error: 'err' },
    ]);
    expect(result).toContain('No content could be scraped');
  });

  it('handles mixed success/failure', () => {
    const result = formatOutput('q', [
      { url: 'https://ok.com', title: 'OK', description: '', content: 'Good content' },
      { url: 'https://bad.com', title: 'Bad', description: '', content: '', error: 'err' },
    ]);
    expect(result).toContain('## Source 1: OK');
    expect(result).toContain('## Failed Sources');
    expect(result).toContain('**Sources found:** 2 | **Successfully scraped:** 1');
  });
});

describe('research — execute', () => {
  let executeFn: (args: any, context: any) => Promise<string>;

  beforeEach(() => {
    jest.clearAllMocks();
    const mockServer = {
      addTool: jest.fn((tool: any) => {
        executeFn = tool.execute;
      }),
    };
    register(mockServer as any);
  });

  it('registers tool with correct name', () => {
    const tools: any[] = [];
    const mockServer = { addTool: jest.fn((t: any) => tools.push(t)) };
    register(mockServer as any);
    expect(tools[0].name).toBe('firecrawl_research');
  });

  it('returns error message when search fails', async () => {
    mockClient.search.mockRejectedValueOnce(new Error('Network error'));
    const result = await executeFn({ query: 'test', numResults: 3 }, mockContext());
    expect(result).toContain('**Error:** Search failed');
  });

  it('returns no results message when search is empty', async () => {
    mockClient.search.mockResolvedValueOnce({ web: [] });
    const result = await executeFn({ query: 'nonexistent', numResults: 5 }, mockContext());
    expect(result).toContain('**No results found.**');
  });

  it('scrapes results and returns formatted output', async () => {
    mockClient.search.mockResolvedValueOnce({
      web: [{ url: 'https://example.com', title: 'Example', description: 'Desc' }],
    });
    mockClient.scrape.mockResolvedValueOnce({
      markdown: '# Example Page\nSome content here.',
      metadata: { title: 'Example', description: 'Desc' },
    });

    const result = await executeFn({ query: 'example query' }, mockContext());
    expect(result).toContain('# Research: example query');
    expect(result).toContain('**Successfully scraped:** 1');
    expect(result).toContain('*Citation: [Example](https://example.com)*');
  });

  it('defaults numResults to 5', async () => {
    mockClient.search.mockResolvedValueOnce({ web: [] });
    await executeFn({ query: 'test' }, mockContext());
    expect(mockClient.search).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ limit: 5 })
    );
  });

  it('isolates per-URL scrape errors', async () => {
    mockClient.search.mockResolvedValueOnce({
      web: [
        { url: 'https://ok.com', title: 'OK', description: '' },
        { url: 'https://fail.com', title: 'Fail', description: '' },
      ],
    });
    mockClient.scrape
      .mockResolvedValueOnce({ markdown: 'Good content', metadata: { title: 'OK' } })
      .mockRejectedValueOnce(new Error('timeout'));

    const result = await executeFn({ query: 'mixed' }, mockContext());
    expect(result).toContain('## Source 1: OK');
    expect(result).toContain('## Failed Sources');
    expect(result).toContain('timeout');
  });
});
