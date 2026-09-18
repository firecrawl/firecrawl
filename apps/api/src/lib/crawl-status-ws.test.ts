import { describe, expect, it } from "vitest";
import { deriveCrawlStatus, shouldCloseCrawlStatusWS } from "./crawl-status-ws";

describe("shouldCloseCrawlStatusWS", () => {
  it("does not close while kickoff is still initializing an empty crawl", () => {
    expect(
      shouldCloseCrawlStatusWS({
        jobCount: 0,
        completedJobCount: 0,
        kickoffFinished: false,
        cancelled: false,
        hasCrawlError: false,
      }),
    ).toBe(false);
  });

  it("closes an empty crawl after kickoff has finished", () => {
    expect(
      shouldCloseCrawlStatusWS({
        jobCount: 0,
        completedJobCount: 0,
        kickoffFinished: true,
        cancelled: false,
        hasCrawlError: false,
      }),
    ).toBe(true);
  });

  it("closes a cancelled crawl even if kickoff never finishes", () => {
    expect(
      shouldCloseCrawlStatusWS({
        jobCount: 2,
        completedJobCount: 0,
        kickoffFinished: false,
        cancelled: true,
        hasCrawlError: false,
      }),
    ).toBe(true);
  });

  it("closes a crawl with a kickoff error", () => {
    expect(
      shouldCloseCrawlStatusWS({
        jobCount: 0,
        completedJobCount: 0,
        kickoffFinished: false,
        cancelled: false,
        hasCrawlError: true,
      }),
    ).toBe(true);
  });

  it("keeps visible jobs open when a kickoff error is present", () => {
    expect(
      shouldCloseCrawlStatusWS({
        jobCount: 2,
        completedJobCount: 0,
        kickoffFinished: false,
        cancelled: false,
        hasCrawlError: true,
      }),
    ).toBe(false);
  });
});

describe("deriveCrawlStatus", () => {
  it("does not mark an empty job list as completed", () => {
    expect(
      deriveCrawlStatus({
        cancelled: false,
        kickoffFinished: false,
        jobCount: 0,
        failedJobCount: 0,
        validJobStatuses: [],
      }),
    ).toBe("scraping");
  });

  it("keeps completed visible jobs scraping while kickoff is unfinished", () => {
    expect(
      deriveCrawlStatus({
        cancelled: false,
        kickoffFinished: false,
        jobCount: 2,
        failedJobCount: 0,
        validJobStatuses: [
          ["job-1", "completed"],
          ["job-2", "completed"],
        ],
      }),
    ).toBe("scraping");
  });

  it("marks an all-failed crawl as completed", () => {
    expect(
      deriveCrawlStatus({
        cancelled: false,
        kickoffFinished: true,
        jobCount: 2,
        failedJobCount: 2,
        validJobStatuses: [],
      }),
    ).toBe("completed");
  });

  it("marks a non-empty all-completed job list as completed", () => {
    expect(
      deriveCrawlStatus({
        cancelled: false,
        kickoffFinished: true,
        jobCount: 2,
        failedJobCount: 0,
        validJobStatuses: [
          ["job-1", "completed"],
          ["job-2", "completed"],
        ],
      }),
    ).toBe("completed");
  });

  it("keeps cancelled crawls cancelled", () => {
    expect(
      deriveCrawlStatus({
        cancelled: true,
        kickoffFinished: false,
        jobCount: 0,
        failedJobCount: 0,
        validJobStatuses: [],
      }),
    ).toBe("cancelled");
  });

  it("keeps active jobs scraping", () => {
    expect(
      deriveCrawlStatus({
        cancelled: false,
        kickoffFinished: true,
        jobCount: 2,
        failedJobCount: 1,
        validJobStatuses: [
          ["job-1", "completed"],
          ["job-2", "active"],
        ],
      }),
    ).toBe("scraping");
  });
});
