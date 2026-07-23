import { shouldForceNonRender } from "../../scraper/scrapeURL/engines/fire-engine";

const fmt = (types: string[]) => types.map(type => ({ type })) as any;

describe("shouldForceNonRender", () => {
  it("opts branding-only scrapes out of render routing", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding"]),
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(true);
  });

  it("keeps render routing when a screenshot format is requested", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding", "screenshot"]),
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
  });

  it("keeps render routing when a screenshot action is requested", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding"]),
        actions: [{ type: "wait" }, { type: "screenshot" }],
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
  });

  it("keeps render routing for audio/video formats", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding", "audio"]),
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
    expect(
      shouldForceNonRender({
        formats: fmt(["branding", "video"]),
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
  });

  it("keeps render routing when the media postprocessor will run", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["branding"]),
        youtubePostprocessorWillRun: true,
      }),
    ).toBe(false);
  });

  it("does nothing for non-branding scrapes", () => {
    expect(
      shouldForceNonRender({
        formats: fmt(["markdown"]),
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
    expect(
      shouldForceNonRender({
        formats: fmt(["markdown"]),
        actions: [{ type: "wait" }],
        youtubePostprocessorWillRun: false,
      }),
    ).toBe(false);
  });
});
