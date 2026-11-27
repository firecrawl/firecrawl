import { parseMarkdownToSentences, assembleAnswer } from "./highlight-spans";
import { lexer } from "marked";

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
  it.each([
    [
      "python",
      "def greet(name):\n    if name:\n        return f'Hello {name}'",
    ],
    ["makefile", "all:\n\tprintf 'done\\n'"],
    ["yaml", "services:\n  api:\n    ports:\n      - 3000"],
  ])("preserves significant whitespace in selected %s code", (lang, code) => {
    const sentences = parseMarkdownToSentences(
      `\`\`\`${lang}\n${code}\n\`\`\``,
    );
    const output = assembleAnswer(
      sentences,
      sentences.map((_, i) => i),
    );
    const blocks = lexer(output).filter(token => token.type === "code");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(code);
    expect(blocks[0].lang).toBe(lang);
    // The model's numbered lines and their indices must stay unchanged.
    expect(sentences.map(sentence => sentence.text)).toEqual(
      code.split("\n").map(line => line.trim()),
    );
  });

  it.each([
    ["markdown", "```js\nconst answer = 42;\n```"],
    ["text", "`````\nThis line must stay inside the code block."],
    [
      "example `literal`",
      "~~~\nThis line must also stay inside the code block.",
    ],
  ])("keeps embedded fences inside selected code (%s)", (lang, code) => {
    const sourceFence = "~".repeat(8);
    const sentences = parseMarkdownToSentences(
      `${sourceFence}${lang}\n${code}\n${sourceFence}`,
    );
    const output = assembleAnswer(
      sentences,
      sentences.map((_, i) => i),
    );
    const blocks = lexer(output).filter(token => token.type !== "space");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "code", text: code, lang });
  });

  it("preserves a selected indented line without adding unselected code", () => {
    const sentences = parseMarkdownToSentences(
      "```python\ndef first():\n    return 1\ndef second():\n    return 2\n```",
    );
    const output = assembleAnswer(sentences, [1]);
    expect(lexer(output).filter(token => token.type === "code")[0].text).toBe(
      "    return 1",
    );
    expect(output).not.toContain("def second");
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
