// src/custom-tools/brand-audit.ts
// Custom tool: firecrawl_brand_audit
// Scrapes rawHtml + screenshot → extracts colours, fonts, logos → structured JSON.
//
// Screenshot fallback: if the first scrape (with screenshot) fails for any reason,
// a second scrape without screenshot is attempted. This adds one extra API call on
// failure paths — acceptable given NFR5 (5s overhead) applies to the happy path.

import { z } from 'zod';
import type { MCP, SessionData } from './types.js';
import { createClient } from './client.js';

interface BrandAuditResult {
  url: string;
  screenshot_url: string | null;
  colours: string[];
  typography: {
    font_families: string[];
  };
  logos: string[];
  favicons: string[];
  og_image: string | null;
  raw_colour_count: number;
  extraction_notes: string[];
}

export function normaliseHex(hex: string): string {
  // Expand #RGB to #RRGGBB, always uppercase
  if (hex.length === 4) {
    return ('#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]).toUpperCase();
  }
  return hex.toUpperCase();
}

export function rgbToHex(r: number, g: number, b: number): string {
  // Clamp each channel to 0–255 before converting to avoid malformed hex strings
  const clamp = (v: number) => Math.min(255, Math.max(0, v));
  return '#' + [r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function extractColours(html: string): { colours: string[]; rawCount: number } {
  const counts = new Map<string, number>();

  // Match hex colours
  const hexPattern = /#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g;
  for (const match of html.matchAll(hexPattern)) {
    const hex = normaliseHex(match[0]);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  // Match rgb/rgba colours
  const rgbPattern = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g;
  for (const match of html.matchAll(rgbPattern)) {
    const hex = rgbToHex(Number(match[1]), Number(match[2]), Number(match[3]));
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  const rawCount = [...counts.values()].reduce((a, b) => a + b, 0);

  // Sort by frequency, exclude near-white (#FFFFFF, #FEFEFE etc) and near-black (#000000, #111111)
  const filtered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex)
    .filter(hex => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const brightness = (r + g + b) / 3;
      return brightness > 20 && brightness < 235; // exclude pure black and near-white
    })
    .slice(0, 20); // top 20 colours

  return { colours: filtered, rawCount };
}

export function extractFontFamilies(html: string): string[] {
  const seen = new Set<string>();
  const pattern = /font-family\s*:\s*([^;}"']+)/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = match[1].trim();
    // Split on comma, clean up each family name
    for (const part of raw.split(',')) {
      const name = part.trim().replace(/^['"]|['"]$/g, '');
      // Skip CSS variable references (var(--font-*)) and other non-name tokens
      if (
        name &&
        !name.toLowerCase().includes('inherit') &&
        !name.toLowerCase().includes('initial') &&
        !name.includes('(') &&
        !name.includes(')') &&
        !name.includes('${')
      ) {
        seen.add(name);
      }
    }
  }
  return [...seen].slice(0, 10);
}

export function extractLogos(html: string, baseUrl: string): string[] {
  const logos: string[] = [];
  const imgPattern = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(imgPattern)) {
    const src = match[0];
    const url = match[1];
    // Skip non-http schemes (data: URIs, javascript:, blob:)
    if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('blob:')) {
      continue;
    }
    // Heuristic: logo in filename, svg, or alt contains logo
    const isLikelyLogo =
      /logo|brand|icon/i.test(url) ||
      url.endsWith('.svg') ||
      /alt=["'][^"']*logo[^"']*["']/i.test(src);
    if (isLikelyLogo) {
      try {
        logos.push(url.startsWith('http') ? url : new URL(url, baseUrl).href);
      } catch {
        // Malformed URL — skip
      }
    }
  }
  return [...new Set(logos)].slice(0, 10);
}

export function extractFavicons(html: string, baseUrl: string): string[] {
  const favicons: string[] = [];
  const pattern = /<link[^>]+rel=["'][^"']*(?:icon|apple-touch-icon)[^"']*["'][^>]*href=["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const href = match[1];
    if (!href || href.startsWith('data:') || href.startsWith('javascript:')) {
      continue;
    }
    try {
      favicons.push(href.startsWith('http') ? href : new URL(href, baseUrl).href);
    } catch {
      // Malformed URL — skip
    }
  }
  return [...new Set(favicons)];
}

export function extractOgImage(html: string): string | null {
  // Use separate double-quote and single-quote patterns to avoid truncation on apostrophes
  const match =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i) ??
    html.match(/<meta[^>]+property='og:image'[^>]+content='([^']+)'/i) ??
    html.match(/<meta[^>]+content='([^']+)'[^>]+property='og:image'/i);
  return match?.[1] ?? null;
}

export function register(server: MCP): void {
  server.addTool({
    name: 'firecrawl_brand_audit',
    description: `
Extract branding elements from any website — colours, typography, logos, and visual identity signals.

**How it works:** Scrapes the page's raw HTML and screenshot, then extracts hex colour palette, font families, logo URLs, favicon URLs, and OG image — returning structured JSON for design intelligence.

**Best for:** Brand research, design brief generation, competitor visual analysis.
**Not for:** Full-site crawls (use firecrawl_crawl). SEO analysis (use firecrawl_seo_audit).

**Usage Example:**
\`\`\`json
{
  "name": "firecrawl_brand_audit",
  "arguments": {
    "url": "https://stripe.com"
  }
}
\`\`\`

**Returns:** Structured JSON — colour palette (hex, frequency-sorted), font families, logo URLs, favicon URLs, og:image, and a screenshot URL for visual review.
`,
    parameters: z.object({
      url: z.string().url().describe('URL of the page to audit for branding elements'),
    }),
    execute: async (args, context) => {
      const { session } = context as { session?: SessionData };
      const { url } = args as { url: string };
      const client = createClient(session);
      const notes: string[] = [];

      let rawHtml = '';
      let screenshotUrl: string | null = null;

      try {
        // Try with screenshot first; fall back to rawHtml-only if it fails
        let raw: any;
        try {
          raw = await client.scrape(url, { formats: ['rawHtml', 'screenshot'] } as any);
        } catch {
          raw = await client.scrape(url, { formats: ['rawHtml'] } as any);
          notes.push('Screenshot unavailable — falling back to HTML-only extraction.');
        }
        const doc = raw as {
          rawHtml?: string;
          screenshot?: string;
          metadata?: { title?: string; description?: string };
        };
        rawHtml = doc.rawHtml ?? '';
        screenshotUrl = doc.screenshot ?? null;

        if (!rawHtml) {
          notes.push('rawHtml was empty — colour and font extraction skipped.');
        }
        if (!screenshotUrl && !notes.some(n => n.includes('Screenshot unavailable'))) {
          notes.push('Screenshot not available for this URL.');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const result: BrandAuditResult = {
          url,
          screenshot_url: null,
          colours: [],
          typography: { font_families: [] },
          logos: [],
          favicons: [],
          og_image: null,
          raw_colour_count: 0,
          extraction_notes: [`Scrape failed — ${message}`],
        };
        return JSON.stringify(result, null, 2);
      }

      const { colours, rawCount } = extractColours(rawHtml);
      const fontFamilies = extractFontFamilies(rawHtml);
      const logos = extractLogos(rawHtml, url);
      const favicons = extractFavicons(rawHtml, url);
      const ogImage = extractOgImage(rawHtml);

      if (colours.length === 0) notes.push('No colour values extracted — page may use CSS variables or external stylesheets.');
      if (fontFamilies.length === 0) notes.push('No font-family declarations found in inline/embedded CSS.');

      const result: BrandAuditResult = {
        url,
        screenshot_url: screenshotUrl,
        colours,
        typography: { font_families: fontFamilies },
        logos,
        favicons,
        og_image: ogImage,
        raw_colour_count: rawCount,
        extraction_notes: notes,
      };
      return JSON.stringify(result, null, 2);
    },
  });
}
