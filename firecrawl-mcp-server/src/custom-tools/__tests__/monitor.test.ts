import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMockClient, mockContext } from './helpers.js';

// Mock createClient before importing monitor
const mockClient = createMockClient();
jest.unstable_mockModule('../client.js', () => ({
  createClient: jest.fn(() => mockClient),
}));

const { diffContent, urlToFilename, getDataDir, register } = await import('../monitor.js');

describe('monitor — urlToFilename', () => {
  it('produces a .json filename', () => {
    const result = urlToFilename('https://example.com');
    expect(result).toMatch(/^[a-f0-9]{64}\.json$/);
  });

  it('produces different filenames for different URLs', () => {
    expect(urlToFilename('https://a.com')).not.toBe(urlToFilename('https://b.com'));
  });

  it('produces same filename for same URL', () => {
    expect(urlToFilename('https://example.com/page')).toBe(urlToFilename('https://example.com/page'));
  });
});

describe('monitor — getDataDir', () => {
  const originalEnv = process.env.MONITOR_DATA_DIR;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MONITOR_DATA_DIR = originalEnv;
    } else {
      delete process.env.MONITOR_DATA_DIR;
    }
  });

  it('uses MONITOR_DATA_DIR env when set', () => {
    process.env.MONITOR_DATA_DIR = '/custom/path';
    expect(getDataDir()).toBe('/custom/path');
  });

  it('defaults to .monitor-baselines in cwd', () => {
    delete process.env.MONITOR_DATA_DIR;
    expect(getDataDir()).toBe(path.join(process.cwd(), '.monitor-baselines'));
  });
});

describe('monitor — diffContent', () => {
  it('returns no changes for identical content', () => {
    const result = diffContent('line 1\nline 2\n', 'line 1\nline 2\n');
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.summary).toBe('No textual changes detected.');
  });

  it('detects added lines', () => {
    const result = diffContent('line 1\n', 'line 1\nline 2\n');
    expect(result.added).toContain('line 2');
    expect(result.removed).toEqual([]);
    expect(result.summary).toContain('1 line(s) added');
  });

  it('detects removed lines', () => {
    const result = diffContent('line 1\nline 2\n', 'line 1\n');
    expect(result.removed).toContain('line 2');
    expect(result.added).toEqual([]);
    expect(result.summary).toContain('1 line(s) removed');
  });

  it('detects both added and removed', () => {
    const result = diffContent('old line\nshared\n', 'shared\nnew line\n');
    expect(result.added).toContain('new line');
    expect(result.removed).toContain('old line');
  });

  it('ignores line reordering', () => {
    const result = diffContent('a\nb\nc\n', 'c\nb\na\n');
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('detects duplicate count changes', () => {
    const result = diffContent('x\nx\n', 'x\n');
    expect(result.removed).toContain('x');
    expect(result.removed).toHaveLength(1);
  });

  it('caps at 50 added/removed lines', () => {
    const oldLines = Array.from({ length: 100 }, (_, i) => `old-${i}`).join('\n');
    const newLines = Array.from({ length: 100 }, (_, i) => `new-${i}`).join('\n');
    const result = diffContent(oldLines, newLines);
    expect(result.added.length).toBeLessThanOrEqual(50);
    expect(result.removed.length).toBeLessThanOrEqual(50);
  });

  it('trims whitespace and ignores empty lines', () => {
    const result = diffContent('  hello  \n\n  world  \n', '  hello  \n  world  \n');
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });
});

describe('monitor — execute', () => {
  let executeFn: (args: any, context: any) => Promise<string>;
  let tmpDir: string;
  const originalEnv = process.env.MONITOR_DATA_DIR;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-'));
    process.env.MONITOR_DATA_DIR = tmpDir;

    const mockServer = {
      addTool: jest.fn((tool: any) => { executeFn = tool.execute; }),
    };
    register(mockServer as any);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env.MONITOR_DATA_DIR = originalEnv;
    } else {
      delete process.env.MONITOR_DATA_DIR;
    }
  });

  it('establishes baseline on first call', async () => {
    mockClient.scrape.mockResolvedValueOnce({ markdown: '# First visit\nContent here.' });

    const result = await executeFn(
      { url: 'https://example.com/pricing', label: 'Pricing' },
      mockContext()
    );
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe('baseline_established');
    expect(parsed.url).toBe('https://example.com/pricing');
    expect(parsed.label).toBe('Pricing');
  });

  it('detects changes on second call', async () => {
    mockClient.scrape.mockResolvedValueOnce({ markdown: '# Page\nOriginal content.' });
    await executeFn({ url: 'https://example.com/page' }, mockContext());

    mockClient.scrape.mockResolvedValueOnce({ markdown: '# Page\nUpdated content.' });
    const result = await executeFn({ url: 'https://example.com/page' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe('changed');
    expect(parsed.diff.added).toContain('Updated content.');
    expect(parsed.diff.removed).toContain('Original content.');
  });

  it('reports unchanged when content is identical', async () => {
    mockClient.scrape.mockResolvedValueOnce({ markdown: '# Same\nContent.' });
    await executeFn({ url: 'https://example.com/same' }, mockContext());

    mockClient.scrape.mockResolvedValueOnce({ markdown: '# Same\nContent.' });
    const result = await executeFn({ url: 'https://example.com/same' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe('unchanged');
  });

  it('returns error when scrape fails', async () => {
    mockClient.scrape.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await executeFn({ url: 'https://example.com/fail' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('Scrape failed');
  });

  it('returns error when scrape returns empty content', async () => {
    mockClient.scrape.mockResolvedValueOnce({ markdown: '   ' });

    const result = await executeFn({ url: 'https://example.com/empty' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('empty content');
  });
});
