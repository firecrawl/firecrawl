import { sanitizeLogData, sanitizeText } from "./sanitize";

const NUL = "\x00";
const FFFD = "\uFFFD";

describe("sanitizeText", () => {
  it("drops NUL bytes", () => {
    expect(sanitizeText(`hello${NUL}world`)).toBe("helloworld");
    expect(sanitizeText(NUL + NUL)).toBe("");
  });

  it("replaces an unpaired low surrogate with U+FFFD", () => {
    // "Łódź" mis-decoded by a client: the stray 0x81 byte became a lone
    // low surrogate, which JSON.stringify emits as "\udc81".
    const input = "wyciek danych Å\udc81Ã³dÅº";
    const output = sanitizeText(input);
    expect(output).toBe(`wyciek danych Å${FFFD}Ã³dÅº`);
    expect(JSON.stringify(output)).not.toContain("\\ud");
  });

  it("replaces an unpaired high surrogate with U+FFFD", () => {
    expect(sanitizeText("a\ud83db")).toBe(`a${FFFD}b`);
    expect(sanitizeText("trailing\ud83d")).toBe(`trailing${FFFD}`);
  });

  it("keeps well-formed surrogate pairs", () => {
    const emoji = "fire 🔥 crawl 🦀";
    expect(sanitizeText(emoji)).toBe(emoji);
  });

  it("handles a lone surrogate next to a valid pair", () => {
    expect(sanitizeText("\udd25🔥\ud83d")).toBe(`${FFFD}🔥${FFFD}`);
  });

  it("returns a clean string by reference", () => {
    const clean = "https://example.com/path?q=ok";
    expect(sanitizeText(clean)).toBe(clean);
  });
});

describe("sanitizeLogData", () => {
  it("cleans strings nested in objects, arrays and keys", () => {
    const row = {
      url: `https://example.com/${NUL}`,
      options: {
        query: `nested${NUL}query`,
        sources: [{ type: "web", location: `New${NUL}York` }],
        headers: { [`X-${NUL}Bad`]: "va\udc81lue" },
      },
      tags: [`a${NUL}`, "🔥"],
    };

    expect(sanitizeLogData(row)).toEqual({
      url: "https://example.com/",
      options: {
        query: "nestedquery",
        sources: [{ type: "web", location: "NewYork" }],
        headers: { "X-Bad": `va${FFFD}lue` },
      },
      tags: ["a", "🔥"],
    });
  });

  it("does not mutate the input", () => {
    const row = { options: { query: `bad${NUL}query` } };
    sanitizeLogData(row);
    expect(row.options.query).toBe(`bad${NUL}query`);
  });

  it("returns Dates and Buffers by reference", () => {
    const created_at = new Date("2026-09-04T13:09:19.785Z");
    const blob = Buffer.from("raw bytes");
    const out = sanitizeLogData({
      created_at,
      blob,
      n: 3,
      ok: true,
      none: null,
    });

    expect(out.created_at).toBe(created_at);
    expect(out.blob).toBe(blob);
    expect(out.n).toBe(3);
    expect(out.ok).toBe(true);
    expect(out.none).toBeNull();
  });

  it("passes primitives through", () => {
    expect(sanitizeLogData(42)).toBe(42);
    expect(sanitizeLogData(null)).toBeNull();
    expect(sanitizeLogData(undefined)).toBeUndefined();
  });

  it("produces JSON that a strict parser accepts", () => {
    const published = JSON.stringify(
      sanitizeLogData({ target_hint: "Å\udc81Ã³d", q: `a${NUL}b` }),
    );
    expect(published).not.toMatch(/\\u[dD][89a-fA-F]/);
    expect(published).not.toMatch(/\\u0{4}/);
    expect(JSON.parse(published)).toEqual({
      target_hint: `Å${FFFD}Ã³d`,
      q: "ab",
    });
  });
});
