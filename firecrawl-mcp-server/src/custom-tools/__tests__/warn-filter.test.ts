import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

describe('console.warn filter', () => {
  let originalWarn: typeof console.warn;
  let passedThrough: string[];

  beforeEach(() => {
    originalWarn = console.warn;
    passedThrough = [];

    // Apply the same filter as src/index.ts
    const _origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (
        typeof args[0] === 'string' &&
        /OpenAI may not support|Could not convert regex pattern|Recursive reference detected/.test(args[0])
      ) {
        return;
      }
      passedThrough.push(String(args[0]));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('suppresses OpenAI records warning', () => {
    console.warn('OpenAI may not support records in schemas! Try an array of key-value pairs instead.');
    expect(passedThrough).toEqual([]);
  });

  it('suppresses regex pattern warning', () => {
    console.warn('Could not convert regex pattern at foo/bar to a flag-independent form! Falling back to the flag-ignorant source');
    expect(passedThrough).toEqual([]);
  });

  it('suppresses recursive reference warning', () => {
    console.warn('Recursive reference detected at baz! Defaulting to any');
    expect(passedThrough).toEqual([]);
  });

  it('passes through legitimate warnings', () => {
    console.warn('Something else entirely');
    expect(passedThrough).toEqual(['Something else entirely']);
  });

  it('passes through non-string arguments', () => {
    console.warn(42);
    expect(passedThrough).toEqual(['42']);
  });
});
