import { describe, expect, it } from 'vitest';
import packageJson from '../../../package.json';

describe('package.json dependencies', () => {
  it('does not declare redundant self-dependency firecrawl', () => {
    const dependencies = packageJson.dependencies || {};
    expect(dependencies).not.toHaveProperty('firecrawl');
  });

  it('declares only valid required runtime dependencies', () => {
    const dependencies = Object.keys(packageJson.dependencies || {});
    // The SDK source strictly imports axios, zod, and zod-to-json-schema.
    // Asserting the exact sorted list ensures no extraneous or circular packages
    // (such as firecrawl) are accidentally reintroduced.
    expect(dependencies.sort()).toEqual(['axios', 'zod', 'zod-to-json-schema']);
  });
});
