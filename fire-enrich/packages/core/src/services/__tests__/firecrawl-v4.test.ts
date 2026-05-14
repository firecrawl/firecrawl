import { beforeEach, describe, expect, it, vi } from 'vitest';

const startCrawlMock = vi.fn();
const getCrawlStatusMock = vi.fn();
const cancelCrawlMock = vi.fn();
const mapMock = vi.fn();
const extractMock = vi.fn();
const startBatchScrapeMock = vi.fn();
const getBatchScrapeStatusMock = vi.fn();

vi.mock('@mendable/firecrawl-js', () => ({
  default: vi.fn().mockImplementation(() => ({
    // v1 shim (unused here but kept so other tests on the same impl work)
    v1: { search: vi.fn(), scrapeUrl: vi.fn() },
    // v4 surface
    startCrawl: startCrawlMock,
    getCrawlStatus: getCrawlStatusMock,
    cancelCrawl: cancelCrawlMock,
    map: mapMock,
    extract: extractMock,
    startBatchScrape: startBatchScrapeMock,
    getBatchScrapeStatus: getBatchScrapeStatusMock,
  })),
}));

const { FirecrawlService } = await import('../firecrawl.js');

beforeEach(() => {
  for (const m of [
    startCrawlMock,
    getCrawlStatusMock,
    cancelCrawlMock,
    mapMock,
    extractMock,
    startBatchScrapeMock,
    getBatchScrapeStatusMock,
  ]) {
    m.mockReset();
  }
});

describe('FirecrawlService.startCrawl', () => {
  it('returns { jobId } extracted from the SDK response.id', async () => {
    startCrawlMock.mockResolvedValue({ id: 'crawl-job-123' });
    const svc = new FirecrawlService('k');
    const out = await svc.startCrawl('https://example.com', { limit: 10 });
    expect(out).toEqual({ jobId: 'crawl-job-123' });
    expect(startCrawlMock).toHaveBeenCalledWith('https://example.com', { limit: 10 });
  });

  it('prepends https:// when URL has no protocol', async () => {
    startCrawlMock.mockResolvedValue({ id: 'x' });
    const svc = new FirecrawlService('k');
    await svc.startCrawl('example.com');
    expect(startCrawlMock).toHaveBeenCalledWith('https://example.com', undefined);
  });

  it('throws when SDK returns no id', async () => {
    startCrawlMock.mockResolvedValue({});
    const svc = new FirecrawlService('k');
    await expect(svc.startCrawl('https://x.test')).rejects.toThrow(/no job id/);
  });
});

describe('FirecrawlService.getCrawlStatus', () => {
  it('passes the SDK response through unchanged', async () => {
    const sample = { status: 'running', completed: 3, total: 10 };
    getCrawlStatusMock.mockResolvedValue(sample);
    const svc = new FirecrawlService('k');
    expect(await svc.getCrawlStatus('id')).toEqual(sample);
    expect(getCrawlStatusMock).toHaveBeenCalledWith('id');
  });
});

describe('FirecrawlService.cancelCrawl', () => {
  it('wraps the SDK boolean as { ok }', async () => {
    cancelCrawlMock.mockResolvedValue(true);
    const svc = new FirecrawlService('k');
    expect(await svc.cancelCrawl('id')).toEqual({ ok: true });
    cancelCrawlMock.mockResolvedValue(false);
    expect(await svc.cancelCrawl('id')).toEqual({ ok: false });
  });
});

describe('FirecrawlService.mapUrl', () => {
  it('flattens link objects to a string[] under { links }', async () => {
    mapMock.mockResolvedValue({
      links: ['https://a.example/1', { url: 'https://a.example/2' }],
    });
    const svc = new FirecrawlService('k');
    const out = await svc.mapUrl('https://a.example');
    expect(out.links).toEqual(['https://a.example/1', 'https://a.example/2']);
  });

  it('returns empty array when SDK omits links', async () => {
    mapMock.mockResolvedValue({});
    const svc = new FirecrawlService('k');
    expect((await svc.mapUrl('a.test')).links).toEqual([]);
  });
});

describe('FirecrawlService.extract', () => {
  it('passes the args object directly to SDK and returns its result', async () => {
    const args = { urls: ['https://x.test'], prompt: 'extract title' };
    extractMock.mockResolvedValue({ data: { title: 'Hi' } });
    const svc = new FirecrawlService('k');
    expect(await svc.extract(args)).toEqual({ data: { title: 'Hi' } });
    expect(extractMock).toHaveBeenCalledWith(args);
  });
});

describe('FirecrawlService.startBatchScrape + getBatchScrapeStatus', () => {
  it('startBatchScrape returns { jobId }', async () => {
    startBatchScrapeMock.mockResolvedValue({ id: 'batch-1' });
    const svc = new FirecrawlService('k');
    expect(await svc.startBatchScrape(['https://a.test', 'https://b.test'])).toEqual({
      jobId: 'batch-1',
    });
  });

  it('getBatchScrapeStatus passes through', async () => {
    const sample = { status: 'completed', total: 2, completed: 2, data: [] };
    getBatchScrapeStatusMock.mockResolvedValue(sample);
    const svc = new FirecrawlService('k');
    expect(await svc.getBatchScrapeStatus('batch-1')).toEqual(sample);
  });
});
