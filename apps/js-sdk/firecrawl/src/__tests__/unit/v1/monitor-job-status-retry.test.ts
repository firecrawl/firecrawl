import FirecrawlApp from '../../../v1';
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

const successResponse = {
  status: 200,
  data: { status: 'completed', data: [{ url: 'test.com', markdown: 'test' }] },
};

function networkError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { response: { status, data: { error: message } } });
}

describe('monitorJobStatus retry logic', () => {
  let app: FirecrawlApp;
  let delays: number[];

  beforeEach(() => {
    app = new FirecrawlApp({ apiKey: 'test-key', apiUrl: 'https://test.com' });
    delays = [];
    jest.useFakeTimers();
    const fakeSetTimeout = globalThis.setTimeout;
    jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return fakeSetTimeout(fn, ms);
    }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function failFirst(n: number, error: Error, statuses: string[] = []) {
    let calls = 0;
    app.getRequest = (async () => {
      calls++;
      if (calls <= n) throw error;
      const status = statuses.shift();
      return status ? { status: 200, data: { status } } : successResponse;
    }) as any;
    return () => calls;
  }

  async function monitor() {
    const result = app.monitorJobStatus('test-id', {} as any, 1);
    result.catch(() => {});
    await jest.runAllTimersAsync();
    return result;
  }

  test.each([
    ['socket hang up', networkError('socket hang up', 'ECONNRESET')],
    ['ETIMEDOUT', networkError('timeout', 'ETIMEDOUT')],
    ['HTTP 408', httpError('Request timeout', 408)],
    ['HTTP 504', httpError('Gateway timeout', 504)],
  ])('retries once after a %s error and returns the job data', async (_label, error) => {
    const calls = failFirst(1, error);

    const result = await monitor();

    expect(calls()).toBe(2);
    expect(result).toEqual(successResponse.data);
    expect(delays).toEqual([1000]);
  });

  test('uses exponential backoff between retries', async () => {
    const calls = failFirst(2, networkError('socket hang up', 'ECONNRESET'));

    const result = await monitor();

    expect(calls()).toBe(3);
    expect(result).toEqual(successResponse.data);
    expect(delays).toEqual([1000, 2000]);
  });

  test('records both the retry backoff and the 2s poll wait for an active job', async () => {
    const calls = failFirst(1, networkError('socket hang up', 'ECONNRESET'), ['active']);

    const result = await monitor();

    expect(calls()).toBe(3);
    expect(result).toEqual(successResponse.data);
    expect(delays).toEqual([1000, 2000]);
  });

  test('fails after max retries are exceeded', async () => {
    const calls = failFirst(Infinity, networkError('socket hang up', 'ECONNRESET'));

    await expect(monitor()).rejects.toThrow('socket hang up');

    expect(calls()).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  test('does not retry non-retryable errors', async () => {
    const calls = failFirst(Infinity, httpError('Unauthorized', 401));

    await expect(monitor()).rejects.toThrow('Unauthorized');

    expect(calls()).toBe(1);
    expect(delays).toEqual([]);
  });
});
