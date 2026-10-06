import { config } from "../../../config";
import { describeIf } from "../lib";
import { idmux, researchRaw } from "./lib";

const HAS_LEGAL_REGULATORY = !!config.SEARCH_PLATFORM_URL;
const PATH = "/v2/search/gov";

describeIf(HAS_LEGAL_REGULATORY)("Government Index Search API", () => {
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
    expect(res.body.data.web.length).toBeGreaterThan(0);
    expect(res.body.data.web.length).toBeLessThanOrEqual(3);
    for (const result of res.body.data.web) {
      expect(typeof result.url).toBe("string");
      expect(typeof result.title).toBe("string");
      expect(typeof result.description).toBe("string");
      expect(typeof result.position).toBe("number");
    }
  }, 120000);
});
