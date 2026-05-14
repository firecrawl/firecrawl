import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createMockClient, mockContext } from './helpers.js';

// Mock createClient before importing seo-audit
const mockClient = createMockClient();
jest.unstable_mockModule('../client.js', () => ({
  createClient: jest.fn(() => mockClient),
}));

const {
  extractMeta,
  extractHeaders,
  partitionLinks,
  countWords,
  detectIssues,
  register,
} = await import('../seo-audit.js');

describe('seo-audit — extractMeta', () => {
  it('extracts title from HTML', () => {
    const html = '<html><head><title>My Page Title</title></head></html>';
    const meta = extractMeta(html, {});
    expect(meta.title).toBe('My Page Title');
    expect(meta.title_length).toBe(13);
  });

  it('prefers firecrawl metadata over HTML', () => {
    const html = '<title>HTML Title</title>';
    const meta = extractMeta(html, { title: 'Firecrawl Title' });
    expect(meta.title).toBe('Firecrawl Title');
  });

  it('extracts meta description', () => {
    const html = '<meta name="description" content="A great page about testing.">';
    const meta = extractMeta(html, {});
    expect(meta.description).toBe('A great page about testing.');
    expect(meta.description_length).toBe('A great page about testing.'.length);
  });

  it('extracts og:title and og:description', () => {
    const html = `
      <meta property="og:title" content="OG Title">
      <meta property="og:description" content="OG Description">
      <meta property="og:image" content="https://example.com/og.png">
    `;
    const meta = extractMeta(html, {});
    expect(meta.og_title).toBe('OG Title');
    expect(meta.og_description).toBe('OG Description');
    expect(meta.og_image).toBe('https://example.com/og.png');
  });

  it('extracts canonical URL', () => {
    const html = '<link rel="canonical" href="https://example.com/page">';
    expect(extractMeta(html, {}).canonical).toBe('https://example.com/page');
  });

  it('extracts robots meta', () => {
    const html = '<meta name="robots" content="index, follow">';
    expect(extractMeta(html, {}).robots).toBe('index, follow');
  });

  it('extracts twitter:card', () => {
    const html = '<meta name="twitter:card" content="summary_large_image">';
    expect(extractMeta(html, {}).twitter_card).toBe('summary_large_image');
  });

  it('returns nulls for missing meta tags', () => {
    const meta = extractMeta('<html></html>', {});
    expect(meta.title).toBeNull();
    expect(meta.description).toBeNull();
    expect(meta.og_title).toBeNull();
    expect(meta.canonical).toBeNull();
    expect(meta.robots).toBeNull();
    expect(meta.title_length).toBe(0);
  });
});

describe('seo-audit — extractHeaders', () => {
  it('extracts H1, H2, H3 from markdown', () => {
    const md = '# Main Title\n\n## Section 1\n\n### Subsection\n\n## Section 2\n';
    const headers = extractHeaders(md);
    expect(headers.h1).toEqual(['Main Title']);
    expect(headers.h2).toEqual(['Section 1', 'Section 2']);
    expect(headers.h3).toEqual(['Subsection']);
    expect(headers.h1_count).toBe(1);
    expect(headers.h2_count).toBe(2);
    expect(headers.h3_count).toBe(1);
  });

  it('ignores headings inside code blocks', () => {
    const md = '```\n# Not a heading\n## Also not\n```\n\n# Real Heading\n';
    const headers = extractHeaders(md);
    expect(headers.h1).toEqual(['Real Heading']);
    expect(headers.h1_count).toBe(1);
  });

  it('caps at 20 items per level', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `# Heading ${i}`).join('\n');
    const headers = extractHeaders(lines);
    expect(headers.h1.length).toBe(20);
    expect(headers.h1_count).toBe(25);
  });

  it('handles empty markdown', () => {
    const headers = extractHeaders('');
    expect(headers.h1).toEqual([]);
    expect(headers.h1_count).toBe(0);
  });
});

describe('seo-audit — partitionLinks', () => {
  it('partitions internal and external links', () => {
    const links = [
      { url: 'https://example.com/about' },
      { url: 'https://blog.example.com/post' },
      { url: 'https://external.com/page' },
    ];
    const result = partitionLinks(links, 'example.com');
    expect(result.internal).toContain('https://example.com/about');
    expect(result.internal).toContain('https://blog.example.com/post');
    expect(result.external).toContain('https://external.com/page');
  });

  it('handles invalid URLs gracefully', () => {
    const links = [{ url: 'not-a-url' }, { url: 'https://example.com/page' }];
    const result = partitionLinks(links, 'example.com');
    expect(result.internal).toEqual(['https://example.com/page']);
    expect(result.external).toEqual([]);
  });

  it('handles empty link list', () => {
    const result = partitionLinks([], 'example.com');
    expect(result.internal).toEqual([]);
    expect(result.external).toEqual([]);
  });
});

describe('seo-audit — countWords', () => {
  it('counts words in plain text', () => {
    expect(countWords('Hello world this is a test')).toBe(6);
  });

  it('strips fenced code blocks', () => {
    const md = 'Before code\n```\nconst x = 1;\nconst y = 2;\n```\nAfter code';
    expect(countWords(md)).toBe(4);
  });

  it('strips inline code', () => {
    expect(countWords('Use `npm install` to install')).toBe(3);
  });

  it('keeps link text but strips URL', () => {
    expect(countWords('Check [this documentation](https://example.com/docs) for more')).toBe(5);
  });

  it('strips heading markers', () => {
    expect(countWords('# Title\n\nSome paragraph text.')).toBe(4);
  });

  it('handles empty string', () => {
    expect(countWords('')).toBe(0);
  });
});

describe('seo-audit — detectIssues', () => {
  const goodResult = {
    url: 'https://example.com',
    meta: {
      title: 'A Good Page Title For SEO Testing!',
      title_length: 34,
      description: 'This is a good meta description that has enough characters to pass the minimum length check.',
      description_length: 91,
      og_title: 'OG Title',
      og_description: 'OG Description',
      og_image: 'https://example.com/og.png',
      canonical: 'https://example.com',
      robots: 'index, follow',
      twitter_card: 'summary',
    },
    headers: { h1: ['Main'], h2: ['Sub'], h3: [], h1_count: 1, h2_count: 1, h3_count: 0 },
    links: { internal_count: 5, external_count: 2, internal_sample: [], external_sample: [] },
    content: { word_count: 500, has_structured_data: true },
  };

  it('returns no issues for a well-optimised page', () => {
    expect(detectIssues(goodResult)).toEqual([]);
  });

  it('flags missing title', () => {
    const result = { ...goodResult, meta: { ...goodResult.meta, title: null, title_length: 0 } };
    expect(detectIssues(result)).toContain('Missing <title> tag');
  });

  it('flags short title', () => {
    const result = { ...goodResult, meta: { ...goodResult.meta, title: 'Short', title_length: 5 } };
    expect(detectIssues(result).some((i: string) => i.includes('Title too short'))).toBe(true);
  });

  it('flags long title', () => {
    const longTitle = 'A'.repeat(65);
    const result = { ...goodResult, meta: { ...goodResult.meta, title: longTitle, title_length: 65 } };
    expect(detectIssues(result).some((i: string) => i.includes('Title too long'))).toBe(true);
  });

  it('flags missing meta description', () => {
    const result = { ...goodResult, meta: { ...goodResult.meta, description: null, description_length: 0 } };
    expect(detectIssues(result)).toContain('Missing meta description');
  });

  it('flags no H1', () => {
    const result = { ...goodResult, headers: { ...goodResult.headers, h1: [], h1_count: 0 } };
    expect(detectIssues(result)).toContain('No H1 heading found');
  });

  it('flags multiple H1s', () => {
    const result = { ...goodResult, headers: { ...goodResult.headers, h1: ['A', 'B', 'C'], h1_count: 3 } };
    expect(detectIssues(result).some((i: string) => i.includes('Multiple H1 headings'))).toBe(true);
  });

  it('flags missing OG tags', () => {
    const result = {
      ...goodResult,
      meta: { ...goodResult.meta, og_title: null, og_description: null, og_image: null },
    };
    const issues = detectIssues(result);
    expect(issues).toContain('Missing og:title (Open Graph)');
    expect(issues).toContain('Missing og:description (Open Graph)');
    expect(issues).toContain('Missing og:image (Open Graph)');
  });

  it('flags missing canonical', () => {
    const result = { ...goodResult, meta: { ...goodResult.meta, canonical: null } };
    expect(detectIssues(result)).toContain('Missing canonical URL');
  });

  it('flags low word count', () => {
    const result = { ...goodResult, content: { ...goodResult.content, word_count: 100 } };
    expect(detectIssues(result).some((i: string) => i.includes('Low word count'))).toBe(true);
  });
});

describe('seo-audit — execute', () => {
  let executeFn: (args: any, context: any) => Promise<string>;

  beforeEach(() => {
    jest.clearAllMocks();
    const mockServer = {
      addTool: jest.fn((tool: any) => { executeFn = tool.execute; }),
    };
    register(mockServer as any);
  });

  it('returns full SEO audit result', async () => {
    mockClient.scrape.mockResolvedValueOnce({
      rawHtml: `
        <html>
          <head>
            <title>Test Page - Example</title>
            <meta name="description" content="A test page for SEO audit with enough characters to pass validation.">
            <meta property="og:title" content="Test OG">
            <meta property="og:description" content="OG Desc">
            <meta property="og:image" content="https://example.com/og.png">
            <link rel="canonical" href="https://example.com/test">
            <script type="application/ld+json">{"@context":"https://schema.org"}</script>
          </head>
          <body></body>
        </html>
      `,
      markdown: '# Test Page\n\n## Section One\n\n' + 'word '.repeat(400),
      links: [
        { url: 'https://example.com/about' },
        { url: 'https://external.com/link' },
      ],
      metadata: { title: 'Test Page - Example' },
    });

    const result = await executeFn({ url: 'https://example.com/test' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.url).toBe('https://example.com/test');
    expect(parsed.meta.title).toBe('Test Page - Example');
    expect(parsed.headers.h1).toEqual(['Test Page']);
    expect(parsed.headers.h2).toEqual(['Section One']);
    expect(parsed.links.internal_count).toBe(1);
    expect(parsed.links.external_count).toBe(1);
    expect(parsed.content.has_structured_data).toBe(true);
    expect(parsed.content.word_count).toBeGreaterThan(300);
    expect(Array.isArray(parsed.issues)).toBe(true);
  });

  it('returns error result when scrape fails', async () => {
    mockClient.scrape.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await executeFn({ url: 'https://example.com' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.error).toContain('Scrape failed');
    expect(parsed.issues).toContain('Scrape failed — cannot perform SEO audit');
  });

  it('includes site map when includeMap is true', async () => {
    mockClient.scrape.mockResolvedValueOnce({
      rawHtml: '<html><head><title>Test</title></head></html>',
      markdown: '# Test\n\n' + 'word '.repeat(400),
      links: [],
      metadata: {},
    });
    mockClient.map.mockResolvedValueOnce({
      urls: ['https://example.com', 'https://example.com/about', 'https://example.com/contact'],
    });

    const result = await executeFn({ url: 'https://example.com', includeMap: true }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.site_map).toBeDefined();
    expect(parsed.site_map.total_pages).toBe(3);
  });

  it('handles map failure gracefully', async () => {
    mockClient.scrape.mockResolvedValueOnce({
      rawHtml: '<html><head><title>Test</title></head></html>',
      markdown: '# Test\n',
      links: [],
      metadata: {},
    });
    mockClient.map.mockRejectedValueOnce(new Error('Map not available'));

    const result = await executeFn({ url: 'https://example.com', includeMap: true }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.issues).toContain('Site map unavailable — map call failed');
  });
});
