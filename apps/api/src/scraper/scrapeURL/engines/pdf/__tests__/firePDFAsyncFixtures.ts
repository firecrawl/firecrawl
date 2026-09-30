import { vi } from "vitest";
import type { Counter } from "prom-client";

// Shared fixtures for the fire-pdf async client suites: a fake response
// shape, a scrape `meta` with a controllable abort/timeout surface, and a
// sequenced fetch stub that asserts each request against the next matcher.

type FakeResponse = {
  status: number;
  body: unknown;
};

export function jsonResp({ status, body }: FakeResponse) {
  return {
    status,
    json: async () => body,
  } as any;
}

export function makeMeta(overrides: Record<string, unknown> = {}) {
  const noopLogger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function child() {
      return noopLogger;
    }),
  };

  return {
    id: "scrape-id-test",
    url: "https://example.com/doc.pdf",
    rewrittenUrl: undefined,
    logger: noopLogger,
    mock: null,
    abort: {
      throwIfAborted: vi.fn(),
      asSignal: vi.fn(() => new AbortController().signal),
      scrapeTimeout: vi.fn(() => 60_000),
    },
    internalOptions: {
      zeroDataRetention: false,
      teamId: "team-x",
      teamConcurrency: 12,
      crawlId: undefined,
    },
    options: {
      parsers: [{ type: "pdf", __firePdfAsync: true }],
    },
    largePdfProcessing: {},
    ...overrides,
  } as any;
}

export function makeFetchFromSequence(
  matchers: Array<{
    matchUrl: RegExp;
    matchMethod?: "DELETE" | "GET" | "POST";
    response: FakeResponse | (() => FakeResponse);
  }>,
) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string> | undefined;
    body: unknown;
  }> = [];
  const cursor = { idx: 0 };
  const fetchImpl: any = async (url: string, init: any) => {
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url, method, headers: init?.headers, body });
    const matcher = matchers[cursor.idx++];
    if (!matcher) {
      throw new Error(
        `unexpected request #${cursor.idx} to ${method} ${url} (no matcher left)`,
      );
    }
    if (!matcher.matchUrl.test(url)) {
      throw new Error(
        `request ${cursor.idx} url mismatch: got ${url}, expected ${matcher.matchUrl}`,
      );
    }
    if (matcher.matchMethod && matcher.matchMethod !== method) {
      throw new Error(
        `request ${cursor.idx} method mismatch: got ${method}, expected ${matcher.matchMethod}`,
      );
    }
    const r =
      typeof matcher.response === "function"
        ? matcher.response()
        : matcher.response;
    return jsonResp(r);
  };
  return { fetchImpl, calls };
}

export const noopSleep = async () => {};

/** Current value of one labelled series of a prom-client counter (0 if unseen). */
export async function counterValue(
  counter: Counter<string>,
  labels: Record<string, string>,
): Promise<number> {
  const { values } = await counter.get();
  const hit = values.find(v =>
    Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val),
  );
  return hit?.value ?? 0;
}
