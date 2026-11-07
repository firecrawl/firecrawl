import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API cancellation", () => {
  it("interrupts Retry-After backoff without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "60" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      const client = new Client({
        apiUrl: "http://localhost:3002",
        retries: { attempts: 3, initialDelayMs: 500 },
      });
      await expect(
        client.scrape({ url: "https://example.com/" }, controller.signal),
      ).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(timer);
    }
  });
});
