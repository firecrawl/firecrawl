import { performRanking } from "./ranker";

describe("performRanking", () => {
  it("should rank links based on similarity to search query", async () => {
    const linksWithContext = [
      "url: https://example.com/dogs, title: All about dogs, description: Learn about different dog breeds",
      "url: https://example.com/cats, title: Cat care guide, description: Everything about cats",
      "url: https://example.com/pets, title: General pet care, description: Care for all types of pets",
    ];

    const links = [
      "https://example.com/dogs",
      "https://example.com/cats",
      "https://example.com/pets",
    ];

    const searchQuery = "cats training";

    const result = await performRanking(linksWithContext, links, searchQuery, {
      teamId: "test-suite",
    });

    // Should return array of objects with link, linkWithContext, score, originalIndex
    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBe(3);

    // First result should be the dogs page since query is about dogs
    expect(result[0].link).toBe("https://example.com/cats");

    // Each result should have required properties
    result.forEach(item => {
      expect(item).toHaveProperty("link");
      expect(item).toHaveProperty("linkWithContext");
      expect(item).toHaveProperty("score");
      expect(item).toHaveProperty("originalIndex");
      expect(typeof item.score).toBe("number");
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(1);
    });

    // Scores should be in descending order
    for (let i = 1; i < result.length; i++) {
      expect(result[i].score).toBeLessThanOrEqual(result[i - 1].score);
    }
  });

  it("should handle empty inputs", async () => {
    const result = await performRanking([], [], "", { teamId: "test-suite" });
    expect(result).toEqual([]);
  });

  it("should maintain original order for equal scores", async () => {
    const linksWithContext = [
      "url: https://example.com/1, title: Similar content A, description: test",
      "url: https://example.com/2, title: Similar content B, description: test",
    ];

    const links = ["https://example.com/1", "https://example.com/2"];

    const searchQuery = "test";

    const result = await performRanking(linksWithContext, links, searchQuery, {
      teamId: "test-suite",
    });

    // If scores are equal, original order should be maintained
    expect(result[0].originalIndex).toBeLessThan(result[1].originalIndex);
  });
});
