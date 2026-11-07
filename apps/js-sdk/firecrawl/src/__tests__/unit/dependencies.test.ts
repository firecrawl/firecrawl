import { describe, expect, it } from 'vitest';
import packageJson from '../../../package.json';

describe('package.json dependencies', () => {
  it('does not depend on itself or redundant firecrawl package', () => {
    const dependencies = packageJson.dependencies || {};
    expect(dependencies).not.toHaveProperty('firecrawl');
  });

  it('declares only valid required runtime dependencies', () => {
    const dependencies = Object.keys(packageJson.dependencies || {});
    // Should only depend on axios, zod, zod-to-json-schema, and typescript-event-target
    expect(dependencies).toEqual(
      expect.arrayContaining([
        'axios',
        'typescript-event-target',
        'zod',
        'zod-to-json-schema',
      ]),
    );
    expect(dependencies).not.toContain('firecrawl');
  });
});
