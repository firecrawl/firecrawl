import { parseMarkdownToSentences, assembleAnswer } from "./highlight-spans";

describe("parseMarkdownToSentences", () => {
  it("splits paragraphs into sentence spans and tags source", () => {
    const s = parseMarkdownToSentences("# Title\n\nFirst. Second.");
    expect(s).toEqual([
      { text: "Title", source: "heading", blockId: 0 },
      { text: "First.", source: "text", blockId: 1 },
      { text: "Second.", source: "text", blockId: 1 },
    ]);
  });

  it("emits a header span plus one span per table row, sharing a blockId", () => {
    const md =
      "| Size | Price |\n| --- | --- |\n| 128GB | $799 |\n| 256GB | $899 |";
    const s = parseMarkdownToSentences(md);
    expect(s).toEqual([
      { text: "Size | Price", source: "table", blockId: 0, isHeader: true },
      { text: "128GB | $799", source: "table", blockId: 0 },
      { text: "256GB | $899", source: "table", blockId: 0 },
    ]);
  });
});

describe("assembleAnswer", () => {
  it("finds headers in bounded work when selecting rows from many tables", () => {
    const tableCount = 1000;
    let blockReads = 0;
    const sentences = Array.from({ length: tableCount }, (_, blockId) => [
      {
        text: `Header ${blockId}`,
        source: "table" as const,
        blockId,
        isHeader: true,
      },
      { text: `Value ${blockId}`, source: "table" as const, blockId },
    ]).flat();
    for (const sentence of sentences) {
      const blockId = sentence.blockId;
      Object.defineProperty(sentence, "blockId", {
        enumerable: true,
        get() {
          blockReads++;
          return blockId;
        },
      });
    }
    const indices = Array.from(
      { length: tableCount },
      (_, index) => 2 * index + 1,
    );

    const result = assembleAnswer(sentences, indices);

    expect(result).toBe(
      Array.from(
        { length: tableCount },
        (_, index) => `| Header ${index} |\n| --- |\n| Value ${index} |`,
      ).join("\n\n"),
    );
    expect(blockReads).toBeLessThanOrEqual(sentences.length * 10);
  });

  it("keeps the first matching header and source order for repeated selections", () => {
    const sentences = [
      { text: "First header", source: "table" as const, blockId: 7, isHeader: true },
      {
        text: "Repeated header",
        source: "table" as const,
        blockId: 7,
        isHeader: true,
      },
      { text: "Value", source: "table" as const, blockId: 7 },
      { text: "No header", source: "table" as const, blockId: 9 },
    ];
    expect(assembleAnswer(sentences, [3, 2, 2, 0])).toBe(
      "| First header |\n| --- |\n| Value |\n\n| No header |",
    );
  });

  it("rebuilds a table and auto-includes its header when only a row is selected", () => {
    const md =
      "| Size | Price |\n| --- | --- |\n| 128GB | $799 |\n| 256GB | $899 |";
    const sentences = parseMarkdownToSentences(md);
    // Select only the "256GB" row (index 2) — header (index 0) must be pulled in.
    const out = assembleAnswer(sentences, [2]);
    expect(out).toBe("| Size | Price |\n| --- | --- |\n| 256GB | $899 |");
  });

  it("merges same-block text spans back into one paragraph", () => {
    const sentences = parseMarkdownToSentences("Alpha. Beta. Gamma.");
    const out = assembleAnswer(sentences, [0, 2]);
    expect(out).toBe("Alpha. Gamma.");
  });

  it("rebuilds a fenced code block from consecutive code spans", () => {
    const md = "```js\nconst a = 1;\nconst b = 2;\n```";
    const sentences = parseMarkdownToSentences(md);
    const out = assembleAnswer(sentences, [0, 1]);
    expect(out).toBe("```js\nconst a = 1;\nconst b = 2;\n```");
  });

  it("returns empty string when nothing is selected", () => {
    const sentences = parseMarkdownToSentences("Alpha. Beta.");
    expect(assembleAnswer(sentences, [])).toBe("");
  });

  it("ignores out-of-range indices", () => {
    const sentences = parseMarkdownToSentences("Alpha.");
    expect(assembleAnswer(sentences, [5, -1])).toBe("");
  });
});
