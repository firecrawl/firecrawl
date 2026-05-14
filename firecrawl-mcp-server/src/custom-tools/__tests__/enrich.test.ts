import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createMockClient, mockContext } from './helpers.js';

// Mock createClient before importing enrich
const mockClient = createMockClient();
jest.unstable_mockModule('../client.js', () => ({
  createClient: jest.fn(() => mockClient),
}));

const { buildSearchQuery, extractProfile, register } = await import('../enrich.js');

describe('enrich — buildSearchQuery', () => {
  it('combines companyName and email domain', () => {
    const result = buildSearchQuery('john@acme.com', 'Acme Corp');
    expect(result.query).toBe('Acme Corp acme.com company website');
    expect(result.emailDomain).toBe('acme.com');
  });

  it('uses only companyName when no email', () => {
    const result = buildSearchQuery(undefined, 'Acme Corp');
    expect(result.query).toBe('Acme Corp company website');
    expect(result.emailDomain).toBeNull();
  });

  it('uses only email domain when no companyName', () => {
    const result = buildSearchQuery('john@acme.com');
    expect(result.query).toBe('acme.com company about');
    expect(result.emailDomain).toBe('acme.com');
  });

  it('returns empty query when neither provided', () => {
    const result = buildSearchQuery();
    expect(result.query).toBe('');
    expect(result.emailDomain).toBeNull();
  });

  it('handles multi-@ email (sub-addressed)', () => {
    const result = buildSearchQuery('user@proxy@actual-domain.com');
    expect(result.emailDomain).toBe('actual-domain.com');
  });
});

describe('enrich — extractProfile', () => {
  it('extracts name from title stripping decorators', () => {
    const profile = extractProfile(
      { title: 'Acme Corp - Leading SaaS Platform', description: 'We build software.', url: 'https://acme.com' },
      'We build software for enterprises.',
      'acme.com',
      'https://acme.com'
    );
    expect(profile.name).toBe('Acme Corp');
    expect(profile.description).toBe('We build software.');
    expect(profile.website).toBe('https://acme.com');
    expect(profile.email_domain).toBe('acme.com');
    expect(profile.industry).toBe('Technology');
  });

  it('detects Marketing industry', () => {
    const profile = extractProfile(
      { title: 'BrandCo', description: 'Digital advertising agency' },
      '', null, 'https://brandco.com'
    );
    expect(profile.industry).toBe('Marketing');
  });

  it('detects Healthcare industry', () => {
    const profile = extractProfile(
      { title: 'MedCo', description: 'Healthcare solutions provider' },
      '', null, 'https://medco.com'
    );
    expect(profile.industry).toBe('Healthcare');
  });

  it('detects Finance industry', () => {
    const profile = extractProfile(
      { title: 'FinCo', description: 'Modern fintech payments' },
      '', null, 'https://finco.com'
    );
    expect(profile.industry).toBe('Finance');
  });

  it('returns null industry when no keywords match', () => {
    const profile = extractProfile(
      { title: 'Mystery Co', description: 'We do things.' },
      'Generic stuff.', null, 'https://mystery.com'
    );
    expect(profile.industry).toBeNull();
  });

  it('returns null name for empty title', () => {
    const profile = extractProfile(
      { title: '', description: 'Something' },
      '', null, 'https://x.com'
    );
    expect(profile.name).toBeNull();
  });

  it('falls back to sourceUrl when metadata.url is missing', () => {
    const profile = extractProfile(
      { title: 'Test' }, '', null, 'https://fallback.com'
    );
    expect(profile.website).toBe('https://fallback.com');
  });
});

describe('enrich — execute', () => {
  let executeFn: (args: any, context: any) => Promise<string>;

  beforeEach(() => {
    jest.clearAllMocks();
    const mockServer = {
      addTool: jest.fn((tool: any) => { executeFn = tool.execute; }),
    };
    register(mockServer as any);
  });

  it('returns not_found when neither email nor companyName provided', async () => {
    const result = await executeFn({}, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.enrichment_status).toBe('not_found');
    expect(parsed.error).toContain('At least one of email or companyName');
  });

  it('returns not_found when search fails', async () => {
    mockClient.search.mockRejectedValueOnce(new Error('API down'));
    const result = await executeFn({ companyName: 'Test Corp' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.enrichment_status).toBe('not_found');
    expect(parsed.error).toContain('Search failed');
  });

  it('returns not_found when search returns empty', async () => {
    mockClient.search.mockResolvedValueOnce({ web: [] });
    const result = await executeFn({ companyName: 'Nonexistent' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.enrichment_status).toBe('not_found');
    expect(parsed.error).toContain('No search results found');
  });

  it('returns partial when scrape fails but search succeeded', async () => {
    mockClient.search.mockResolvedValueOnce({
      web: [{ url: 'https://test.com', title: 'Test', description: 'Desc' }],
    });
    mockClient.scrape.mockRejectedValueOnce(new Error('Scrape timeout'));

    const result = await executeFn({ companyName: 'Test Corp' }, mockContext());
    const parsed = JSON.parse(result as string);
    expect(parsed.enrichment_status).toBe('partial');
    expect(parsed.company.name).toBe('Test');
    expect(parsed.error).toContain('Scrape failed');
  });

  it('returns full enrichment on success', async () => {
    mockClient.search.mockResolvedValueOnce({
      web: [{ url: 'https://acme.com', title: 'Acme Corp', description: 'SaaS platform' }],
    });
    mockClient.scrape.mockResolvedValueOnce({
      markdown: 'We are a leading software platform.',
      metadata: { title: 'Acme Corp - SaaS Platform', description: 'Leading software.', url: 'https://acme.com' },
    });

    const result = await executeFn(
      { email: 'john@acme.com', companyName: 'Acme Corp' },
      mockContext()
    );
    const parsed = JSON.parse(result as string);
    expect(parsed.enrichment_status).toBe('full');
    expect(parsed.company.name).toBe('Acme Corp');
    expect(parsed.company.industry).toBe('Technology');
    expect(parsed.source).toBe('https://acme.com');
    expect(parsed.sources_searched).toContain('https://acme.com');
  });
});
