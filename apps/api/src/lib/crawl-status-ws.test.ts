import { describe, expect, it } from "vitest";
import { deriveCrawlStatus, shouldCloseCrawlStatusWS } from "./crawl-status-ws";

describe("shouldCloseCrawlStatusWS", () => {
  it("does not close while kickoff is still initializing an empty crawl", () => {
    expect(shouldCloseCrawlStatusWS(0, 0, false)).toBe(false);
  });

  it("closes an empty crawl after kickoff has finished", () => {
    expect(shouldCloseCrawlStatusWS(0, 0, true)).toBe(true);
  });
});

describe("deriveCrawlStatus", () => {
  it("does not mark an empty job list as completed", () => {
    expect(deriveCrawlStatus(false, 0, 0, [])).toBe("scraping");
  });

  it("marks an all-failed crawl as completed", () => {
    expect(deriveCrawlStatus(false, 2, 2, [])).toBe("completed");
  });

  it("marks a non-empty all-completed job list as completed", () => {
    expect(
      deriveCrawlStatus(false, 2, 2, [
        ["job-1", "completed"],
        ["job-2", "completed"],
      ]),
    ).toBe("completed");
  });

  it("keeps cancelled crawls cancelled", () => {
    expect(deriveCrawlStatus(true, 0, 0, [])).toBe("cancelled");
  });

  it("keeps active jobs scraping", () => {
    expect(
      deriveCrawlStatus(false, 2, 1, [
        ["job-1", "completed"],
        ["job-2", "active"],
      ]),
    ).toBe("scraping");
  });
});
