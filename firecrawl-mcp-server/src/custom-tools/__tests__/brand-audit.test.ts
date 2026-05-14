import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createMockClient, mockContext } from './helpers.js';

// Mock createClient before importing brand-audit
const mockClient = createMockClient();
jest.unstable_mockModule('../client.js', () => ({
  createClient: jest.fn(() => mockClient),
}));

const {
  normaliseHex,
  rgbToHex,
  extractColours,
  extractFontFamilies,
  extractLogos,
  extractFavicons,
  extractOgImage,
  register,
} = await import('../brand-audit.js');

describe('brand-audit — normaliseHex', () => {
  it('expands 3-char hex to 6-char uppercase', () => {
    expect(normaliseHex('#abc')).toBe('#AABBCC');
  });

  it('uppercases 6-char hex', () => {
    expect(normaliseHex('#ff5733')).toBe('#FF5733');
  });

  it('handles already uppercase', () => {
    expect(normaliseHex('#FF5733')).toBe('#FF5733');
  });
});

describe('brand-audit — rgbToHex', () => {
  it('converts rgb values to hex', () => {
    expect(rgbToHex(255, 87, 51)).toBe('#FF5733');
  });

  it('converts black', () => {
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
  });

  it('converts white', () => {
    expect(rgbToHex(255, 255, 255)).toBe('#FFFFFF');
  });

  it('clamps values above 255', () => {
    expect(rgbToHex(300, 256, 999)).toBe('#FFFFFF');
  });

  it('clamps negative values to 0', () => {
    expect(rgbToHex(-1, -50, -100)).toBe('#000000');
  });
});

describe('brand-audit — extractColours', () => {
  it('extracts hex colours from HTML', () => {
    const html = '<div style="color: #ff5733; background: #3498db;">';
    const result = extractColours(html);
    expect(result.colours).toContain('#FF5733');
    expect(result.colours).toContain('#3498DB');
  });

  it('extracts rgb colours and converts to hex', () => {
    const html = '<div style="color: rgb(255, 87, 51);">';
    const result = extractColours(html);
    expect(result.colours).toContain('#FF5733');
  });

  it('filters out near-white and near-black', () => {
    const html = '<div style="color: #ffffff; background: #000000; border: #ff5733;">';
    const result = extractColours(html);
    expect(result.colours).not.toContain('#FFFFFF');
    expect(result.colours).not.toContain('#000000');
    expect(result.colours).toContain('#FF5733');
  });

  it('sorts by frequency', () => {
    const html = '<div style="color: #aabbcc;"></div><span style="color: #aabbcc;"></span><p style="color: #ff5733;">';
    const result = extractColours(html);
    expect(result.colours[0]).toBe('#AABBCC');
  });

  it('limits to 20 colours', () => {
    const colours = Array.from({ length: 30 }, (_, i) =>
      `#${(i + 30).toString(16).padStart(2, '0')}8080`
    );
    const html = colours.map(c => `<div style="color: ${c};">`).join('');
    const result = extractColours(html);
    expect(result.colours.length).toBeLessThanOrEqual(20);
  });

  it('returns rawCount of all occurrences', () => {
    const html = '<div style="color: #ff5733; background: #ff5733; border: #3498db;">';
    const result = extractColours(html);
    expect(result.rawCount).toBe(3);
  });

  it('handles empty HTML', () => {
    const result = extractColours('');
    expect(result.colours).toEqual([]);
    expect(result.rawCount).toBe(0);
  });

  it('deduplicates 3-char and 6-char hex of same colour', () => {
    const html = '<div style="color: #abc;"><span style="color: #AABBCC;">';
    const result = extractColours(html);
    expect(result.rawCount).toBe(2);
    // Both map to same key, so only one unique colour
    const aabbccCount = result.colours.filter(c => c === '#AABBCC').length;
    expect(aabbccCount).toBeLessThanOrEqual(1);
  });
});

describe('brand-audit — extractFontFamilies', () => {
  it('extracts unquoted font-family declarations', () => {
    const html = '<style>body { font-family: Inter, sans-serif; }</style>';
    const result = extractFontFamilies(html);
    expect(result).toContain('Inter');
    expect(result).toContain('sans-serif');
  });

  it('skips inherit/initial values', () => {
    const html = '<style>body { font-family: inherit; }</style>';
    const result = extractFontFamilies(html);
    expect(result).not.toContain('inherit');
  });

  it('skips CSS variables', () => {
    const html = '<div style="font-family: var(--font-body);">';
    const result = extractFontFamilies(html);
    expect(result).toEqual([]);
  });

  it('deduplicates font names', () => {
    const html = '<style>h1 { font-family: Inter; } p { font-family: Inter; }</style>';
    const result = extractFontFamilies(html);
    expect(result.filter(f => f === 'Inter')).toHaveLength(1);
  });

  it('limits to 10 families', () => {
    const fonts = Array.from({ length: 15 }, (_, i) => `Font${i}`);
    const html = fonts.map(f => `<div style="font-family: ${f};">`).join('');
    const result = extractFontFamilies(html);
    expect(result.length).toBeLessThanOrEqual(10);
  });
});

describe('brand-audit — extractLogos', () => {
  it('finds images with logo in filename', () => {
    const html = '<img src="https://example.com/logo.png" alt="Company">';
    expect(extractLogos(html, 'https://example.com')).toContain('https://example.com/logo.png');
  });

  it('finds SVG images', () => {
    const html = '<img src="/assets/brand.svg" alt="Brand">';
    expect(extractLogos(html, 'https://example.com')).toContain('https://example.com/assets/brand.svg');
  });

  it('finds images with logo in alt text', () => {
    const html = '<img src="https://example.com/img.png" alt="Company Logo">';
    expect(extractLogos(html, 'https://example.com')).toContain('https://example.com/img.png');
  });

  it('skips data: URIs', () => {
    const html = '<img src="data:image/png;base64,abc" alt="Logo">';
    expect(extractLogos(html, 'https://example.com')).toEqual([]);
  });

  it('resolves relative URLs', () => {
    const html = '<img src="/images/logo.png" alt="test">';
    expect(extractLogos(html, 'https://example.com')).toContain('https://example.com/images/logo.png');
  });

  it('deduplicates logos', () => {
    const html = '<img src="https://example.com/logo.png"><img src="https://example.com/logo.png">';
    expect(extractLogos(html, 'https://example.com')).toHaveLength(1);
  });
});

describe('brand-audit — extractFavicons', () => {
  it('extracts link rel=icon', () => {
    const html = '<link rel="icon" href="/favicon.ico">';
    expect(extractFavicons(html, 'https://example.com')).toContain('https://example.com/favicon.ico');
  });

  it('extracts apple-touch-icon', () => {
    const html = '<link rel="apple-touch-icon" href="/apple-icon.png">';
    expect(extractFavicons(html, 'https://example.com')).toContain('https://example.com/apple-icon.png');
  });

  it('handles absolute URLs', () => {
    const html = '<link rel="icon" href="https://cdn.example.com/icon.png">';
    expect(extractFavicons(html, 'https://example.com')).toContain('https://cdn.example.com/icon.png');
  });

  it('skips data: URIs', () => {
    const html = '<link rel="icon" href="data:image/png;base64,abc">';
    expect(extractFavicons(html, 'https://example.com')).toEqual([]);
  });
});

describe('brand-audit — extractOgImage', () => {
  it('extracts og:image with double quotes', () => {
    const html = '<meta property="og:image" content="https://example.com/og.png">';
    expect(extractOgImage(html)).toBe('https://example.com/og.png');
  });

  it('extracts og:image with reversed attribute order', () => {
    const html = '<meta content="https://example.com/og.png" property="og:image">';
    expect(extractOgImage(html)).toBe('https://example.com/og.png');
  });

  it('extracts og:image with single quotes', () => {
    const html = "<meta property='og:image' content='https://example.com/og.png'>";
    expect(extractOgImage(html)).toBe('https://example.com/og.png');
  });

  it('returns null when no og:image', () => {
    expect(extractOgImage('<meta property="og:title" content="Title">')).toBeNull();
  });
});

describe('brand-audit — execute', () => {
  let executeFn: (args: any, context: any) => Promise<string>;

  beforeEach(() => {
    jest.clearAllMocks();
    const mockServer = {
      addTool: jest.fn((tool: any) => { executeFn = tool.execute; }),
    };
    register(mockServer as any);
  });

  it('returns structured brand audit result', async () => {
    mockClient.scrape.mockResolvedValueOnce({
      rawHtml: `
        <html>
          <head>
            <meta property="og:image" content="https://example.com/og.png">
            <link rel="icon" href="/favicon.ico">
            <style>body { font-family: Inter, sans-serif; color: #3498db; }</style>
          </head>
          <body><img src="/logo.svg" alt="Brand"></body>
        </html>
      `,
      screenshot: 'https://example.com/screenshot.png',
    });

    const result = await executeFn({ url: 'https://example.com' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.url).toBe('https://example.com');
    expect(parsed.screenshot_url).toBe('https://example.com/screenshot.png');
    expect(parsed.colours).toContain('#3498DB');
    expect(parsed.typography.font_families).toContain('Inter');
    expect(parsed.og_image).toBe('https://example.com/og.png');
    expect(parsed.logos.length).toBeGreaterThan(0);
    expect(parsed.favicons.length).toBeGreaterThan(0);
  });

  it('falls back to HTML-only when screenshot scrape fails', async () => {
    mockClient.scrape
      .mockRejectedValueOnce(new Error('Screenshot not supported'))
      .mockResolvedValueOnce({
        rawHtml: '<html><body style="color: #ff5733;"></body></html>',
      });

    const result = await executeFn({ url: 'https://example.com' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.screenshot_url).toBeNull();
    expect(parsed.colours).toContain('#FF5733');
    expect(parsed.extraction_notes).toContain('Screenshot unavailable — falling back to HTML-only extraction.');
  });

  it('returns error result when both scrapes fail', async () => {
    mockClient.scrape
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'));

    const result = await executeFn({ url: 'https://example.com' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.colours).toEqual([]);
    expect(parsed.extraction_notes[0]).toContain('Scrape failed');
  });
});
