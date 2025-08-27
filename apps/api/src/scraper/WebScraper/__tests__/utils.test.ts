import { WebCrawler } from '../crawler';

describe('WebCrawler - noSections', () => {
  let crawler: WebCrawler;

  beforeEach(() => {
    crawler = new WebCrawler({
      jobId: 'test-job',
      initialUrl: 'https://example.com',
      baseUrl: 'https://example.com',
      includes: [],
      excludes: [],
    });
  });

  describe('noSections method', () => {
    it('should return true for URLs without hash fragments', () => {
      expect(crawler['noSections']('https://example.com/page')).toBe(true);
      expect(crawler['noSections']('https://example.com/blog/post')).toBe(true);
      expect(crawler['noSections']('https://example.com')).toBe(true);
    });

    it('should return false for simple anchor links', () => {
      expect(crawler['noSections']('https://example.com/page#section')).toBe(false);
      expect(crawler['noSections']('https://example.com/page#top')).toBe(false);
      expect(crawler['noSections']('https://example.com/page#')).toBe(false);
      expect(crawler['noSections']('https://example.com/page#a')).toBe(false);
    });

    it('should return true for hash fragments that look like routes', () => {
      expect(crawler['noSections']('https://example.com/app#/dashboard')).toBe(true);
      expect(crawler['noSections']('https://example.com/spa#/user/profile')).toBe(true);
      expect(crawler['noSections']('https://example.com/page#/settings/account')).toBe(true);
    });

    it('should return false for short hash fragments even with slashes', () => {
      expect(crawler['noSections']('https://example.com/page#/')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(crawler['noSections']('https://example.com/page#ab')).toBe(false);
      expect(crawler['noSections']('https://example.com/page#abc/def')).toBe(true);
    });
  });
});
