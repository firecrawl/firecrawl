import {
  garbledTextRatio,
  isLikelyGarbled,
  GARBLED_TEXT_THRESHOLD,
} from "../textQuality";

describe("garbledTextRatio", () => {
  it("returns 0 for a clean ASCII paragraph", () => {
    const text =
      "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.";
    expect(garbledTextRatio(text)).toBe(0);
    expect(isLikelyGarbled(text)).toBe(false);
  });

  it("returns 0 for a clean Chinese paragraph (real Hanzi)", () => {
    const text = "你好世界，这是一段正常的中文文本，用于测试质量检测。";
    expect(garbledTextRatio(text)).toBe(0);
    expect(isLikelyGarbled(text)).toBe(false);
  });

  it("returns ~1 for a string full of replacement characters", () => {
    const text = "�".repeat(50);
    expect(garbledTextRatio(text)).toBe(1);
    expect(isLikelyGarbled(text)).toBe(true);
  });

  it("flags a string full of Private Use Area codepoints", () => {
    // U+E000..U+E031
    let text = "";
    for (let cp = 0xe000; cp < 0xe032; cp++) {
      text += String.fromCodePoint(cp);
    }
    expect(garbledTextRatio(text)).toBe(1);
    expect(isLikelyGarbled(text)).toBe(true);
  });

  it("flags Plane 15/16 PUA codepoints", () => {
    const text =
      String.fromCodePoint(0xf0000).repeat(10) +
      String.fromCodePoint(0x100000).repeat(10);
    expect(garbledTextRatio(text)).toBe(1);
    expect(isLikelyGarbled(text)).toBe(true);
  });

  it("flags C0/C1 control characters but not tab/newline/CR", () => {
    const controls = "\x00\x01\x02\x7f\x80\x9f".repeat(10);
    expect(garbledTextRatio(controls)).toBe(1);

    // Whitespace controls are excluded entirely (denominator skips them).
    expect(garbledTextRatio("\t\n\r")).toBe(0);
  });

  it("stays below threshold for mostly clean text with a few symbols", () => {
    const text =
      "Energy E = mc² and the area is πr². Temperature was 20°C. " +
      "Mostly normal prose with the occasional symbol sprinkled in.";
    const ratio = garbledTextRatio(text);
    expect(ratio).toBeLessThan(GARBLED_TEXT_THRESHOLD);
    expect(isLikelyGarbled(text)).toBe(false);
  });

  it("excludes whitespace from the denominator", () => {
    // 5 replacement chars surrounded by lots of spaces. The spaces must not
    // dilute the ratio.
    const text = "     " + "�".repeat(5) + "     ";
    expect(garbledTextRatio(text)).toBe(1);
  });

  it("returns 0 for empty or whitespace only input", () => {
    expect(garbledTextRatio("")).toBe(0);
    expect(garbledTextRatio("   \t\n  ")).toBe(0);
    expect(isLikelyGarbled("")).toBe(false);
    expect(isLikelyGarbled("   ")).toBe(false);
  });

  it("counts code points, not code units, for astral characters", () => {
    // Emoji (astral, not suspect) mixed with clean text stays clean.
    const text = "Hello 👋 world 🌍 this is fine";
    expect(garbledTextRatio(text)).toBe(0);
  });

  it("trips on a realistically garbled CJK extraction", () => {
    // Simulates a broken ToUnicode CMap: PUA glyph codes interleaved with
    // replacement chars, the kind of output the fast path emits for an
    // unmappable CJK font.
    const garbled =
      String.fromCodePoint(0xe010, 0xe011, 0xfffd, 0xe012, 0xfffd, 0xe013) + "";
    expect(isLikelyGarbled(garbled)).toBe(true);
  });

  it("honors a custom threshold", () => {
    const text = "abcd�"; // ratio 0.2
    expect(garbledTextRatio(text)).toBeCloseTo(0.2);
    expect(isLikelyGarbled(text)).toBe(false);
    expect(isLikelyGarbled(text, 0.1)).toBe(true);
  });
});
