import { describe, expect, it } from 'vitest';
import packageJson from '../../../package.json';

describe('package.json dependencies', () => {
  it('does not depend on itself or redundant firecrawl package', () => {
    const dependencies = packageJson.dependencies || {};
    expect(dependencies).not.toHaveProperty('firecrawl');
  });

  it('declares only valid required runtime dependencies', () => {
    const dependencies = Object.keys(packageJson.dependencies || {});
    // Runtime dependencies the SDK actually imports.
    expect(dependencies).toEqual(
      expect.arrayContaining(['axios', 'zod', 'zod-to-json-schema']),
    );
    expect(dependencies).not.toContain('firecrawl');
  });
});
