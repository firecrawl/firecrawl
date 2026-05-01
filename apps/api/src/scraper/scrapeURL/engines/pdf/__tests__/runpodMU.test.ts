import { buildRunPodMUInput } from "../runpodMU";

describe("buildRunPodMUInput", () => {
  const base = {
    base64Content: "JVBERi0xLjQK",
    filename: "doc.pdf",
    timeoutMs: 30000,
    createdAt: 1700000000000,
  };

  it("forces OCR backend when mode='ocr' (Pylon #28619)", () => {
    // The bug: mode='ocr' only skipped the Rust fast path but never
    // reached MinerU, so text-layer PDFs got native text extraction
    // instead of forced OCR. The fix: pass parse_method='ocr' so MinerU
    // overrides its 'auto' default and rasterizes every page.
    const input = buildRunPodMUInput({
      ...base,
      maxPages: undefined,
      mode: "ocr",
    });
    expect(input.parse_method).toBe("ocr");
  });

  it("omits parse_method for mode='auto' (preserves prior behavior)", () => {
    const input = buildRunPodMUInput({
      ...base,
      maxPages: undefined,
      mode: "auto",
    });
    expect(input).not.toHaveProperty("parse_method");
  });

  it("omits parse_method for mode='fast' (fast never reaches MU anyway)", () => {
    const input = buildRunPodMUInput({
      ...base,
      maxPages: undefined,
      mode: "fast",
    });
    expect(input).not.toHaveProperty("parse_method");
  });

  it("omits parse_method when mode is undefined (callers without mode)", () => {
    const input = buildRunPodMUInput({
      ...base,
      maxPages: undefined,
      mode: undefined,
    });
    expect(input).not.toHaveProperty("parse_method");
  });

  it("includes max_pages only when set", () => {
    expect(
      buildRunPodMUInput({ ...base, maxPages: 5, mode: undefined }),
    ).toMatchObject({ max_pages: 5 });
    expect(
      buildRunPodMUInput({ ...base, maxPages: undefined, mode: undefined }),
    ).not.toHaveProperty("max_pages");
  });

  it("forwards content / filename / timeout verbatim", () => {
    const input = buildRunPodMUInput({
      ...base,
      maxPages: undefined,
      mode: undefined,
    });
    expect(input.file_content).toBe(base.base64Content);
    expect(input.filename).toBe(base.filename);
    expect(input.timeout).toBe(base.timeoutMs);
    expect(input.created_at).toBe(base.createdAt);
  });
});
