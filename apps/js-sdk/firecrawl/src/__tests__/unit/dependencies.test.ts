import { describe, expect, it } from 'vitest';
import packageJson from '../../../package.json';

describe('package.json dependencies', () => {
  it('does not depend on itself or redundant firecrawl package', () => {
    const dependencies = packageJson.dependencies || {};
    expect(dependencies).not.toHaveProperty('firecrawl');
  });

  it('declares only valid required runtime dependencies', () => {
    const dependencies = Object.keys(packageJson.dependencies || {});
    // The SDK imports these and nothing else. Comparing the full list is the
    // point: a check that only asserts these are present still passes when a
    // new runtime dependency is added.
    expect(dependencies.sort()).toEqual(['axios', 'zod', 'zod-to-json-schema']);
  });
});
