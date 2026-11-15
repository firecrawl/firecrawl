import { config } from "../../../config";
import { describeIf } from "../lib";
import { idmux, researchRaw, scrapeTimeout } from "./lib";

const HAS_GOV = !!config.SEARCH_PLATFORM_URL;
const PATH = "/v2/search/gov";

describeIf(HAS_GOV)("Government Index Search API", () => {
  it("serves a search as web results", async () => {
    const identity = await idmux({
      name: "gov/get",
      credits: 100,
    });

    const res = await researchRaw(
      PATH,
      { query: "food labeling requirements", k: 3 },
      identity,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.web)).toBe(true);
    expect(res.body.data.web.length).toBeGreaterThan(0);
    expect(res.body.data.web.length).toBeLessThanOrEqual(3);
    for (const result of res.body.data.web) {
      expect(typeof result.url).toBe("string");
      expect(typeof result.title).toBe("string");
      expect(typeof result.description).toBe("string");
      expect(typeof result.position).toBe("number");
    }
  }, 120000);

  it(
    "returns gov results with index labels and keeps web results plain",
    async () => {
      const identity = await idmux({ name: "gov/gov-group", credits: 100 });

      const res = await researchRaw(
        PATH,
        {
          query: "qualified immunity excessive force",
          k: 5,
          jurisdiction: "us",
          sources: ["web", "gov"],
        },
        identity,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      const { web, gov } = res.body.data;
      expect(Array.isArray(gov)).toBe(true);
      expect(gov.length).toBeGreaterThan(0);
      expect(gov.map((r: any) => r.url)).toEqual(web.map((r: any) => r.url));
      for (const result of web) {
        for (const key of [
          "jurisdiction",
          "court",
          "courtType",
          "cites",
          "citedAs",
          "updatedAt",
          "lang",
        ]) {
          expect(result[key]).toBeUndefined();
        }
      }
      for (const result of gov) {
        expect(typeof result.url).toBe("string");
        expect(typeof result.position).toBe("number");
        for (const key of ["court_type", "cited_as", "updated_at"]) {
          expect(result[key]).toBeUndefined();
        }
        if (result.updatedAt !== undefined) {
          expect(typeof result.updatedAt).toBe("number");
        }
        if (result.lang !== undefined) {
          expect(typeof result.lang).toBe("string");
        }
        if (result.jurisdiction !== undefined) {
          expect(result.jurisdiction).toBe("us");
        }
        for (const key of ["cites", "citedAs"]) {
          if (result[key] !== undefined) {
            expect(Array.isArray(result[key])).toBe(true);
          }
        }
      }
    },
    scrapeTimeout,
  );

  it(
    "refuses a source other than web or gov",
    async () => {
      const identity = await idmux({ name: "gov/bad-source", credits: 100 });

      const res = await researchRaw(
        PATH,
        { query: "zoning", sources: ["news"] },
        identity,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});
