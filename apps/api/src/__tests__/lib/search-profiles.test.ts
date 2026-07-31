import { describe, expect, it } from "vitest";
import {
  buildSearchProfileRequests,
  resolveSearchProfiles,
} from "../../search/profiles";

describe("search profiles", () => {
  it("auto-routes developer, research, PDF, and general queries", () => {
    expect(resolveSearchProfiles("firecrawl github sdk")[0].name).toBe(
      "developer",
    );
    expect(
      resolveSearchProfiles("weighted sampling research paper")[0].name,
    ).toBe("research");
    expect(resolveSearchProfiles("download the full text pdf")[0].name).toBe(
      "pdf",
    );
    expect(resolveSearchProfiles("best restaurants in Montreal")[0].name).toBe(
      "general",
    );
  });

  it("lets explicit categories override automatic intent", () => {
    expect(
      resolveSearchProfiles("github implementation", ["research"]),
    ).toEqual([{ name: "research", explicit: true, sites: undefined }]);
  });

  it("deduplicates mixed explicit profiles and preserves custom sites", () => {
    expect(
      resolveSearchProfiles("sampling", [
        "research",
        { type: "research", sites: ["example.edu"] },
        "pdf",
      ]),
    ).toEqual([
      { name: "research", explicit: true, sites: ["example.edu"] },
      { name: "pdf", explicit: true, sites: undefined },
    ]);
  });

  it("only adds ecosystem engines when the query asks for them", () => {
    const profile = resolveSearchProfiles("firecrawl sdk github")[0];
    const ordinary = buildSearchProfileRequests(
      "firecrawl sdk github",
      profile,
    );
    expect(ordinary[0].engines).toContain("github");
    expect(ordinary[0].engines).not.toContain("docker hub");
    expect(ordinary[0].engines).not.toContain("npm");

    const packageSearch = buildSearchProfileRequests(
      "firecrawl npm package",
      profile,
    );
    expect(packageSearch[0].engines).toContain("npm");
  });

  it("keeps site operators away from specialist research APIs", () => {
    const profile = resolveSearchProfiles("fairness paper", ["research"])[0];
    const requests = buildSearchProfileRequests("fairness paper", profile);
    expect(requests[0].query).toBe("fairness paper");
    expect(requests[0].engines).toContain("crossref");
    expect(requests[1].query).toContain("site:arxiv.org");
    expect(requests[1].engines).toEqual(["braveapi"]);
  });
});
