import FirecrawlApp from '../../../index';
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

describe('monitorJobStatus retry logic', () => {
  let app: FirecrawlApp;
  let originalConsoleWarn: typeof console.warn;
  
  beforeEach(() => {
    app = new FirecrawlApp({ apiKey: 'test-key', apiUrl: 'https://test.com' });
    originalConsoleWarn = console.warn;
    console.warn = jest.fn();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    jest.clearAllMocks();
  });

  test('should retry on socket hang up error', async () => {
    const socketHangUpError = new Error('socket hang up') as any;
    socketHangUpError.code = 'ECONNRESET';
    
    const successResponse = {
      status: 200,
      data: { status: 'completed', data: [{ url: 'test.com', markdown: 'test' }] }
    };

    const originalGetRequest = app.getRequest;
    let callCount = 0;
    
    app.getRequest = async function(url: string, headers: any) {
      callCount++;
      if (callCount === 1) {
        throw socketHangUpError;
      }
      return successResponse;
    };

    const result = await app.monitorJobStatus('test-id', {}, 1);
    
    expect(callCount).toBe(2);
    expect(result).toEqual(successResponse.data);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Network error during job status check (attempt 1/3): socket hang up')
    );
  });

  test('should retry on ETIMEDOUT error', async () => {
    const timeoutError = new Error('timeout') as any;
    timeoutError.code = 'ETIMEDOUT';
    
    const successResponse = {
      status: 200,
      data: { status: 'completed', data: [{ url: 'test.com', markdown: 'test' }] }
    };

    const originalGetRequest = app.getRequest;
    let callCount = 0;
    
    app.getRequest = async function(url: string, headers: any) {
      callCount++;
      if (callCount === 1) {
        throw timeoutError;
      }
      return successResponse;
    };

    const result = await app.monitorJobStatus('test-id', {}, 1);
    
    expect(callCount).toBe(2);
    expect(result).toEqual(successResponse.data);
  });

  test('should fail after max retries exceeded', async () => {
    const socketHangUpError = new Error('socket hang up') as any;
    socketHangUpError.code = 'ECONNRESET';
    
    app.getRequest = async function(url: string, headers: any) {
      throw socketHangUpError;
    };

    await expect(app.monitorJobStatus('test-id', {}, 1)).rejects.toThrow('socket hang up');
    
    expect(console.warn).toHaveBeenCalledTimes(3);
  }, 15000);

  test('should not retry on non-retryable errors', async () => {
    const authError = new Error('Unauthorized') as any;
    authError.response = { status: 401, data: { error: 'Unauthorized' } };
    
    app.getRequest = async function(url: string, headers: any) {
      throw authError;
    };

    await expect(app.monitorJobStatus('test-id', {}, 1)).rejects.toThrow('Unauthorized');
    
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('should retry on HTTP timeout status codes', async () => {
    const timeoutError = new Error('Request timeout') as any;
    timeoutError.response = { status: 408, data: { error: 'Request timeout' } };
    
    const successResponse = {
      status: 200,
      data: { status: 'completed', data: [{ url: 'test.com', markdown: 'test' }] }
    };

    const originalGetRequest = app.getRequest;
    let callCount = 0;
    
    app.getRequest = async function(url: string, headers: any) {
      callCount++;
      if (callCount === 1) {
        throw timeoutError;
      }
      return successResponse;
    };

    const result = await app.monitorJobStatus('test-id', {}, 1);
    
    expect(callCount).toBe(2);
    expect(result).toEqual(successResponse.data);
  });

  test('should use exponential backoff for retries', async () => {
    const socketHangUpError = new Error('socket hang up') as any;
    socketHangUpError.code = 'ECONNRESET';
    
    const successResponse = {
      status: 200,
      data: { status: 'completed', data: [{ url: 'test.com', markdown: 'test' }] }
    };

    const originalGetRequest = app.getRequest;
    let callCount = 0;
    
    app.getRequest = async function(url: string, headers: any) {
      callCount++;
      if (callCount <= 2) {
        throw socketHangUpError;
      }
      return successResponse;
    };

    const startTime = Date.now();
    const result = await app.monitorJobStatus('test-id', {}, 1);
    const endTime = Date.now();
    
    expect(callCount).toBe(3);
    expect(result).toEqual(successResponse.data);
    expect(endTime - startTime).toBeGreaterThan(3000);
  });
});
