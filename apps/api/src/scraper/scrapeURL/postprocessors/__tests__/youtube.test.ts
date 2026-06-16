import { youtubePostprocessor } from "../youtube";

describe("youtubePostprocessor.shouldRun", () => {
  const meta = {} as any;

  it("runs for YouTube live video URLs", () => {
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://www.youtube.com/live/H4fUJQCIV5E"),
      ),
    ).toBe(true);
  });

  it("keeps existing YouTube video URL support", () => {
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://www.youtube.com/watch?v=H4fUJQCIV5E"),
      ),
    ).toBe(true);
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://youtu.be/H4fUJQCIV5E"),
      ),
    ).toBe(true);
  });

  it("runs for YouTube Shorts video URLs", () => {
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://www.youtube.com/shorts/H4fUJQCIV5E"),
      ),
    ).toBe(true);
  });

  it("does not run for non-video YouTube paths or already processed URLs", () => {
    expect(
      youtubePostprocessor.shouldRun(meta, new URL("https://www.youtube.com/")),
    ).toBe(false);
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://www.youtube.com/live/"),
      ),
    ).toBe(false);
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://www.youtube.com/shorts/"),
      ),
    ).toBe(false);
    expect(
      youtubePostprocessor.shouldRun(
        meta,
        new URL("https://www.youtube.com/live/H4fUJQCIV5E"),
        ["youtube"],
      ),
    ).toBe(false);
  });
});
