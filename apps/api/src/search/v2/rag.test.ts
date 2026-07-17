import { cosineSimilarity, selectTopPassages } from "./rag";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
  });
  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it("returns 0 for a zero vector (avoids div-by-zero)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe("selectTopPassages", () => {
  const query = [1, 0];
  const chunks = [
    { text: "least relevant", start: 0 },
    { text: "most relevant", start: 100 },
    { text: "mid relevant", start: 200 },
  ];
  // aligned with chunks: 0.1, 0.9, 0.5
  const embeddings = [
    [0.1, 0.99],
    [0.9, 0.43],
    [0.5, 0.86],
  ];

  it("ranks passages by similarity to the query, descending", () => {
    const picked = selectTopPassages(query, embeddings, chunks, 3);
    expect(picked.map(p => p.text)).toEqual([
      "most relevant",
      "mid relevant",
      "least relevant",
    ]);
    expect(picked[0].score).toBeGreaterThan(picked[1].score);
  });

  it("respects the top-k limit", () => {
    const picked = selectTopPassages(query, embeddings, chunks, 2);
    expect(picked).toHaveLength(2);
    expect(picked[0].text).toBe("most relevant");
  });

  it("returns fewer than k when chunks are scarce", () => {
    const picked = selectTopPassages(query, [embeddings[0]], [chunks[0]], 5);
    expect(picked).toHaveLength(1);
  });

  it("returns an empty array when there are no chunks", () => {
    expect(selectTopPassages(query, [], [], 3)).toEqual([]);
  });
});
