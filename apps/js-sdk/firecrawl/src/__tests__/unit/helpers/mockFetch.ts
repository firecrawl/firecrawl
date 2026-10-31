import { vi } from "vitest";

export type SentRequest = {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: any;
};

export type MockReply = { status?: number; data?: unknown; headers?: Record<string, string> };

/** Replaces global fetch (restored after each test by `unstubGlobals`) and returns the requests it received. */
export function mockFetch(route: (req: SentRequest) => MockReply | Promise<MockReply>): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const req: SentRequest = {
      url,
      path: new URL(url).pathname,
      method: (init.method ?? "GET").toLowerCase(),
      headers: Object.fromEntries(new Headers(init.headers)),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    sent.push(req);
    const { status = 200, data, headers } = await route(req);
    return new Response(data === undefined ? null : typeof data === "string" ? data : JSON.stringify(data), {
      status,
      headers,
    });
  });
  return sent;
}
