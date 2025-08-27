import { describe, it, expect, beforeAll } from '@jest/globals';
import { deepResearch, idmux, Identity } from './lib';

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "deep-research",
    concurrency: 100,
    tokens: 1000000,
  });
}, 10000);

describe('Deep Research', () => {
  if (!process.env.TEST_SUITE_SELF_HOSTED || process.env.OPENAI_API_KEY || process.env.OLLAMA_BASE_URL) {
    it('successfully completes a basic research query', async () => {
    const query = 'What is artificial intelligence?';
    
    try {
      const result = await deepResearch({
        query: query,
        maxDepth: 2,
        maxUrls: 3,
        timeLimit: 300, // 5 minutes in seconds
      }, identity);
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.data).toBeDefined();
      expect(typeof result.data.finalAnalysis).toBe('string');
      expect(result.data.finalAnalysis.length).toBeGreaterThan(0);
      expect(Array.isArray(result.data.sources)).toBe(true);
      expect(result.data.sources.length).toBeGreaterThan(0);
      expect(Array.isArray(result.data.activities)).toBe(true);
      expect(result.data.activities.length).toBeGreaterThan(0);
    } catch (error) {
      console.error('Deep research test failed with error:', error);
      throw error;
    }
    }, 300000); // 5 minutes timeout to account for processing time
  } else {
    it("dummy test", () => {
      expect(true).toBe(true);
    });
  }
});
