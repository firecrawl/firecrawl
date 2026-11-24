vi.mock("../../services/index", async importOriginal => ({
  ...(await importOriginal<typeof import("../../services/index")>()),
  queryIndexAtDomainSplitLevelWithMeta: vi.fn(),
  queryIndexAtSplitLevelWithMeta: vi.fn(),
}));

import { queryIndex } from "../map-utils";
import {
  queryIndexAtDomainSplitLevelWithMeta,
  queryIndexAtSplitLevelWithMeta,
} from "../../services/index";

describe("queryIndex", () => {
  beforeEach(() => {
    vi.mocked(queryIndexAtDomainSplitLevelWithMeta).mockReset();
    vi.mocked(queryIndexAtSplitLevelWithMeta).mockReset();
  });

  it("returns empty without querying when useIndex is false", async () => {
    const res = await queryIndex("https://example.com/", 100, false, true);
    expect(res).toEqual([]);
    expect(queryIndexAtDomainSplitLevelWithMeta).not.toHaveBeenCalled();
    expect(queryIndexAtSplitLevelWithMeta).not.toHaveBeenCalled();
  });

  it("queries only domain splits for a root URL when includeSubdomains is true", async () => {
    const domainDocs = [{ url: "https://sub.example.com/a", title: "A" }];
    vi.mocked(queryIndexAtDomainSplitLevelWithMeta).mockResolvedValue(
      domainDocs,
    );

    const res = await queryIndex("https://example.com/", 500, true, true);

    expect(res).toEqual(domainDocs);
    expect(queryIndexAtDomainSplitLevelWithMeta).toHaveBeenCalledTimes(1);
    expect(queryIndexAtDomainSplitLevelWithMeta).toHaveBeenCalledWith(
      "example.com",
      500,
    );
    expect(queryIndexAtSplitLevelWithMeta).not.toHaveBeenCalled();
  });

  it("normalizes www subdomains before querying domain splits", async () => {
    const domainDocs = [{ url: "https://docs.example.com/intro" }];
    vi.mocked(queryIndexAtDomainSplitLevelWithMeta).mockResolvedValue(
      domainDocs,
    );

    const res = await queryIndex(
      "https://www.docs.example.com/",
      50,
      true,
      true,
    );

    expect(res).toEqual(domainDocs);
    expect(queryIndexAtDomainSplitLevelWithMeta).toHaveBeenCalledWith(
      "docs.example.com",
      50,
    );
    expect(queryIndexAtSplitLevelWithMeta).not.toHaveBeenCalled();
  });

  it("uses domain splits at the inclusive 5-level boundary", async () => {
    const domainDocs = [{ url: "https://b.c.d.e.example.com/page" }];
    vi.mocked(queryIndexAtDomainSplitLevelWithMeta).mockResolvedValue(
      domainDocs,
    );

    const res = await queryIndex(
      "https://b.c.d.e.example.com/",
      50,
      true,
      true,
    );

    expect(res).toEqual(domainDocs);
    expect(queryIndexAtDomainSplitLevelWithMeta).toHaveBeenCalledTimes(1);
    expect(queryIndexAtDomainSplitLevelWithMeta).toHaveBeenCalledWith(
      "b.c.d.e.example.com",
      50,
    );
    expect(queryIndexAtSplitLevelWithMeta).not.toHaveBeenCalled();
  });

  it("queries only URL splits for a root URL when includeSubdomains is false", async () => {
    const splitDocs = [{ url: "https://example.com/about" }];
    vi.mocked(queryIndexAtSplitLevelWithMeta).mockResolvedValue(splitDocs);

    const res = await queryIndex("https://example.com/", 200, true, false);

    expect(res).toEqual(splitDocs);
    expect(queryIndexAtSplitLevelWithMeta).toHaveBeenCalledTimes(1);
    expect(queryIndexAtSplitLevelWithMeta).toHaveBeenCalledWith(
      "https://example.com/",
      200,
    );
    expect(queryIndexAtDomainSplitLevelWithMeta).not.toHaveBeenCalled();
  });

  it.each([
    ["IPv4 literal", "http://127.0.0.1:4321/"],
    ["localhost", "http://localhost:4321/"],
    [
      "subdomain deeper than 5 domain split levels",
      "https://a.b.c.d.e.example.com/",
    ],
  ])(
    "falls back to URL splits for %s when includeSubdomains is true",
    async (_label, url) => {
      const splitDocs = [{ url: `${url}page` }];
      vi.mocked(queryIndexAtSplitLevelWithMeta).mockResolvedValue(splitDocs);

      const res = await queryIndex(url, 100, true, true);

      expect(res).toEqual(splitDocs);
      expect(queryIndexAtDomainSplitLevelWithMeta).not.toHaveBeenCalled();
      expect(queryIndexAtSplitLevelWithMeta).toHaveBeenCalledTimes(1);
      expect(queryIndexAtSplitLevelWithMeta).toHaveBeenCalledWith(url, 100);
    },
  );

  it("queries only URL splits for non-root paths even when includeSubdomains is true", async () => {
    const splitDocs = [{ url: "https://example.com/blog/post" }];
    vi.mocked(queryIndexAtSplitLevelWithMeta).mockResolvedValue(splitDocs);

    const res = await queryIndex("https://example.com/blog", 100, true, true);

    expect(res).toEqual(splitDocs);
    expect(queryIndexAtDomainSplitLevelWithMeta).not.toHaveBeenCalled();
    expect(queryIndexAtSplitLevelWithMeta).toHaveBeenCalledTimes(1);
    expect(queryIndexAtSplitLevelWithMeta).toHaveBeenCalledWith(
      "https://example.com/blog",
      100,
    );
  });
});
