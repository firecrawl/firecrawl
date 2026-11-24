import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("undici", () => ({
  Agent: mocks.agent,
  fetch: mocks.fetch,
}));

vi.mock("../config", () => ({
  config: { RESEARCH_PROXY_URL: "https://research.test/" },
}));

import { getErrorHttpResponse } from "./error";
import {
  fetchResearchUpstream,
  UsOnlyUpstreamRefusalError,
} from "./research-upstream";

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchResearchUpstream", () => {
  it("keeps the 120 second fallback when no operation timeout is supplied", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);

    await fetchResearchUpstream({
      path: "/v2/research/unlisted",
      params: {},
      queryKeys: [],
      headers: {},
    });

    expect(timeout).toHaveBeenCalledWith(120_000);
    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL("https://research.test/v2/research/unlisted"),
      expect.objectContaining({ signal }),
    );
  });

  it("uses a supplied operation timeout", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);

    await fetchResearchUpstream({
      path: "/v2/research/papers",
      params: { query: "graph databases" },
      queryKeys: ["query"],
      headers: {},
      timeoutMs: 30_000,
    });

    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(mocks.fetch).toHaveBeenCalledWith(
      new URL("https://research.test/v2/research/papers?query=graph+databases"),
      expect.objectContaining({ signal }),
    );
  });

  it("limits connection setup without dispatcher headers or body timeouts", () => {
    expect(mocks.agent).toHaveBeenCalledWith({ connectTimeout: 10_000 });
  });
});

describe("UsOnlyUpstreamRefusalError", () => {
  it("exposes status and US_ONLY_UNAVAILABLE code for 403 responses", () => {
    const error = new UsOnlyUpstreamRefusalError(403, "Blocked by region");
    expect(getErrorHttpResponse(error)).toEqual({
      status: 403,
      code: "US_ONLY_UNAVAILABLE",
      message: "Blocked by region",
    });
  });

  it("exposes status without a code for non-403 responses", () => {
    const error = new UsOnlyUpstreamRefusalError(502, "Upstream unavailable");
    expect(getErrorHttpResponse(error)).toEqual({
      status: 502,
      message: "Upstream unavailable",
    });
  });
});
