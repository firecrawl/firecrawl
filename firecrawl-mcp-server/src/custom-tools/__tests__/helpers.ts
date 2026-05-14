import { jest } from '@jest/globals';

export function createMockClient() {
  return {
    search: jest.fn<any>(),
    scrape: jest.fn<any>(),
    map: jest.fn<any>(),
  };
}

export function mockContext(session: Record<string, unknown> = {}) {
  return {
    session,
    log: {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
    client: { version: '1.0.0' },
    reportProgress: jest.fn(),
    streamContent: jest.fn(),
  };
}
