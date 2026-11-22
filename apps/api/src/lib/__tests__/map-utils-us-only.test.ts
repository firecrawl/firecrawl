import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../validateUrl", async importOriginal => ({
  ...(await importOriginal<typeof import("../validateUrl")>()),
  resolveRedirects: vi.fn(async (url: string) => url),
}));

// Discovery starts with the crawler, so stopping there keeps the test to the
// redirect lookup that runs before it.
vi.mock("../crawl-redis", () => ({
  crawlToCrawler: vi.fn(() => {
    throw new Error("stopped before discovery");
  }),
}));

import { getMapResults } from "../map-utils";
import { resolveRedirects } from "../validateUrl";

const map = (flags: { usOnly?: boolean } | null) =>
  getMapResults({ url: "https://example.com/", teamId: "team-a", flags });

beforeEach(() => {
  vi.mocked(resolveRedirects).mockClear();
});

describe("map redirect lookup", () => {
  it("is skipped for a US-only team, since it fetches outside fire-engine", async () => {
    await expect(map({ usOnly: true })).rejects.toThrow(
      "stopped before discovery",
    );
    expect(resolveRedirects).not.toHaveBeenCalled();
  });

  it("runs for other teams", async () => {
    await expect(map(null)).rejects.toThrow("stopped before discovery");
    expect(vi.mocked(resolveRedirects).mock.calls[0][0]).toBe(
      "https://example.com/",
    );
  });
});
