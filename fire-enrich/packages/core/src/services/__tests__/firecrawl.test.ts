import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchMock = vi.fn();
const scrapeUrlMock = vi.fn();

vi.mock('@mendable/firecrawl-js', () => ({
  default: vi.fn().mockImplementation(() => ({
    search: searchMock,
    scrapeUrl: scrapeUrlMock,
    v1: { search: searchMock, scrapeUrl: scrapeUrlMock },
  })),
}));

const { FirecrawlService } = await import('../firecrawl.js');

beforeEach(() => {
  searchMock.mockReset();
  scrapeUrlMock.mockReset();
});

describe('FirecrawlService.search', () => {
  it('maps SDK response to legacy SearchResult[] shape', async () => {
    searchMock.mockResolvedValue({
      data: [
        {
          url: 'https://a.example',
          title: 'A',
          description: 'desc A',
          markdown: '# A',
          html: '<h1>A</h1>',
          links: ['/x'],
          metadata: { foo: 'bar' },
        },
        { url: 'https://b.example', title: 'B', description: 'desc B' },
      ],
    });
    const svc = new FirecrawlService('test-key');

    const results = await svc.search('test query');

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      url: 'https://a.example',
      title: 'A',
      description: 'desc A',
      markdown: '# A',
      html: '<h1>A</h1>',
      links: ['/x'],
      metadata: { foo: 'bar' },
    });
    expect(results[1]).toMatchObject({
      url: 'https://b.example',
      title: 'B',
      description: 'desc B',
    });
  });

  it('falls back to empty fields when SDK omits them', async () => {
    searchMock.mockResolvedValue({ data: [{}] });
    const svc = new FirecrawlService('test-key');

    const results = await svc.search('q');

    expect(results[0]).toEqual({
      url: '',
      title: '',
      description: '',
      markdown: undefined,
      html: undefined,
      links: undefined,
      metadata: undefined,
    });
  });
});

describe('FirecrawlService.scrapeUrl', () => {
  it('returns the SDK response when scrape succeeds', async () => {
    scrapeUrlMock.mockResolvedValue({
      data: { markdown: '# Hello', html: '<h1>Hello</h1>' },
    });
    const svc = new FirecrawlService('test-key');

    const result = await svc.scrapeUrl('https://example.com');

    expect(result).toEqual({ data: { markdown: '# Hello', html: '<h1>Hello</h1>' } });
  });

  it('prepends https:// when URL has no protocol', async () => {
    scrapeUrlMock.mockResolvedValue({ data: {} });
    const svc = new FirecrawlService('test-key');

    await svc.scrapeUrl('example.com');

    expect(scrapeUrlMock).toHaveBeenCalledWith('https://example.com', expect.any(Object));
  });
});
