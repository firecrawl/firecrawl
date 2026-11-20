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
      {
        text: "Size | Price",
        source: "table",
        blockId: 0,
        isHeader: true,
        tableCells: ["Size", "Price"],
      },
      {
        text: "128GB | $799",
        source: "table",
        blockId: 0,
        tableCells: ["128GB", "$799"],
      },
      {
        text: "256GB | $899",
        source: "table",
        blockId: 0,
        tableCells: ["256GB", "$899"],
      },
    ]);
  });

  it("preserves model-facing candidate text and indices around empty cells", () => {
    const markdown = [
      "Intro.",
      "| | Result |\n| --- | --- |\n| Ada | |\n| | |\n| Bob | Pass |",
      "Between.",
      "| | |\n| --- | --- |\n| | 42 |",
      "After.",
    ].join("\n\n");

    const indexedLines = parseMarkdownToSentences(markdown)
      .map((s, i) => `${i}: ${s.text}`)
      .join("\n");
    expect(indexedLines).toBe(
      "0: Intro.\n1: Result\n2: Ada\n3: Bob | Pass\n4: Between.\n5: 42\n6: After.",
    );
  });

  it("does not add model candidates for a fully empty table", () => {
    const markdown = "| | |\n| --- | --- |\n| | |\n\nAfter.";
    expect(parseMarkdownToSentences(markdown)).toEqual([
      { text: "After.", source: "text", blockId: 1 },
    ]);
  });
});

describe("assembleAnswer", () => {
  it.each([
    {
      name: "an empty middle cell",
      markdown:
        "| Name | Note | Result |\n| --- | --- | --- |\n| Ada | | Pass |",
      expected:
        "| Name | Note | Result |\n| --- | --- | --- |\n| Ada |  | Pass |",
    },
    {
      name: "an empty first cell",
      markdown: "| Name | Score |\n| --- | --- |\n| | 42 |",
      expected: "| Name | Score |\n| --- | --- |\n|  | 42 |",
    },
    {
      name: "an empty last cell",
      markdown: "| Model | Cost |\n| --- | --- |\n| Local | |",
      expected: "| Model | Cost |\n| --- | --- |\n| Local |  |",
    },
    {
      name: "an unnamed header column",
      markdown: "| | Result |\n| --- | --- |\n| Ada | Pass |",
      expected: "|  | Result |\n| --- | --- |\n| Ada | Pass |",
    },
    {
      name: "a table whose header cells are all empty",
      markdown: "| | |\n| --- | --- |\n| Alpha | Beta |",
      expected: "|  |  |\n| --- | --- |\n| Alpha | Beta |",
    },
  ])("keeps column positions for $name", ({ markdown, expected }) => {
    const sentences = parseMarkdownToSentences(markdown);
    const row = sentences.findIndex(s => s.source === "table" && !s.isHeader);
    expect(row).toBeGreaterThanOrEqual(0);
    expect(assembleAnswer(sentences, [row])).toBe(expected);
  });

  it("still omits table body rows with no visible cell text", () => {
    const markdown =
      "| Name | Result |\n| --- | --- |\n| | |\n| Ada | Pass |\n| | |";
    const sentences = parseMarkdownToSentences(markdown);
    expect(sentences).toHaveLength(2);
    expect(assembleAnswer(sentences, [1])).toBe(
      "| Name | Result |\n| --- | --- |\n| Ada | Pass |",
    );
  });

  it("keeps empty header columns when only the header is selected", () => {
    const markdown =
      "| Name | | Result |\n| --- | --- | --- |\n| Ada | | Pass |";
    expect(assembleAnswer(parseMarkdownToSentences(markdown), [0])).toBe(
      "| Name |  | Result |\n| --- | --- | --- |",
    );
  });

  it("adds a blank header once for multiple selected rows", () => {
    const markdown =
      "| | |\n| --- | --- |\n| Ada | |\n| Bob | Skip |\n| | Pass |";
    expect(assembleAnswer(parseMarkdownToSentences(markdown), [2, 0])).toBe(
      "|  |  |\n| --- | --- |\n| Ada |  |\n|  | Pass |",
    );
  });

  it("continues accepting table spans without cell metadata", () => {
    expect(
      assembleAnswer(
        [
          {
            text: "Name | Result",
            source: "table",
            blockId: 0,
            isHeader: true,
          },
          { text: "Ada | Pass", source: "table", blockId: 0 },
        ],
        [1],
      ),
    ).toBe("| Name | Result |\n| --- | --- |\n| Ada | Pass |");
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
