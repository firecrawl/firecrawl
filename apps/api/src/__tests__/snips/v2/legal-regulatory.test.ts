import { config } from "../../../config";
import { describeIf } from "../lib";
import { idmux, researchPostRaw, researchRaw } from "./lib";

const HAS_LEGAL_REGULATORY = !!config.LEGAL_REGULATORY_SEARCH_URL;
const PATH = "/v2/search/gov";

describeIf(HAS_LEGAL_REGULATORY)("Legal and Regulatory Search API", () => {
  it("serves a search as web results", async () => {
    const identity = await idmux({
      name: "legal-regulatory/get",
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
    expect(res.body.data.web.length).toBeLessThanOrEqual(3);
    for (const result of res.body.data.web) {
      expect(typeof result.url).toBe("string");
      expect(typeof result.title).toBe("string");
      expect(typeof result.description).toBe("string");
      expect(typeof result.position).toBe("number");
    }
  }, 120000);

  it("serves the same search from a POST body", async () => {
    const identity = await idmux({
      name: "legal-regulatory/post",
      credits: 100,
    });

    const res = await researchPostRaw(
      PATH,
      { query: "zoning variance hearing", k: 2 },
      identity,
    );

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data.web)).toBe(true);
  }, 120000);

  it("rejects unknown params and an out-of-bound k", async () => {
    const identity = await idmux({
      name: "legal-regulatory/invalid input",
      credits: 100,
    });

    for (const params of [
      { query: "zoning", magic: "true" } as any,
      { query: "zoning", k: 101 },
    ]) {
      const res = await researchRaw(PATH, params, identity);
      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    }
  });
});
