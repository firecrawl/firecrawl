import {
  performCosineSimilarity,
  performCosineSimilarityV2,
} from "./map-cosine";
import { MapDocument } from "../controllers/v2/types";

describe("performCosineSimilarity", () => {
  it("keeps umlaut terms intact when ranking links", () => {
    const links = [
      "https://example.com/reisen-nach-munchen",
      "https://example.com/reisen-nach-m%C3%BCnchen",
      "https://example.com/berlin",
    ];

    const ranked = performCosineSimilarity(links, "münchen");
    expect(ranked[0]).toBe("https://example.com/reisen-nach-m%C3%BCnchen");
  });

  it("returns original order for symbol-only queries", () => {
    const links = [
      "https://example.com/foo",
      "https://example.com/bar",
      "https://example.com/baz",
    ];

    const ranked = performCosineSimilarity(links, "++--??");
    expect(ranked).toEqual(links);
  });
});

describe("performCosineSimilarityV2", () => {
  it("supports umlaut queries for map document ranking", () => {
    const links: MapDocument[] = [
      { url: "https://example.com/reisen-nach-munchen" },
      { url: "https://example.com/reisen-nach-m%C3%BCnchen" },
      { url: "https://example.com/berlin" },
    ];

    const ranked = performCosineSimilarityV2(links, "münchen");
    expect(ranked[0].url).toBe("https://example.com/reisen-nach-m%C3%BCnchen");
  });
});
