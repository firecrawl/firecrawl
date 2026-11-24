import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const undiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async importOriginal => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: undiciFetch };
});

import { robustFetch } from "./fetch";
import { FIRE_CRAWL_AGENT_USER_AGENT } from "./user-agent";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function okResponse() {
  return {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify({ ok: true }),
  };
}

function sentHeaders(): Record<string, string> {
  return undiciFetch.mock.calls[0][1].headers;
}

describe("robustFetch User-Agent", () => {
  beforeEach(() => {
    undiciFetch.mockReset();
    undiciFetch.mockResolvedValue(okResponse());
  });

  it("sends the identifiable User-Agent when the caller omits headers", async () => {
    await robustFetch({
      url: "https://example.com/",
      logger: logger as any,
      method: "GET",
      mock: null,
      schema: z.object({ ok: z.boolean() }),
    });

    expect(sentHeaders()["User-Agent"]).toBe(FIRE_CRAWL_AGENT_USER_AGENT);
  });

  it("keeps caller headers and still sends the default User-Agent", async () => {
    await robustFetch({
      url: "https://example.com/",
      logger: logger as any,
      method: "GET",
      mock: null,
      headers: { "X-Test": "1" },
      schema: z.object({ ok: z.boolean() }),
    });

    expect(sentHeaders()).toMatchObject({ "X-Test": "1" });
    expect(sentHeaders()["User-Agent"]).toBe(FIRE_CRAWL_AGENT_USER_AGENT);
  });

  it("lets a caller-supplied User-Agent win over the default", async () => {
    await robustFetch({
      url: "https://example.com/",
      logger: logger as any,
      method: "GET",
      mock: null,
      headers: { "User-Agent": "Custom/1.0" },
      schema: z.object({ ok: z.boolean() }),
    });

    const headers = sentHeaders();
    expect(headers["User-Agent"]).toBe("Custom/1.0");
    expect(
      Object.keys(headers).filter(k => k.toLowerCase() === "user-agent"),
    ).toHaveLength(1);
  });
});
