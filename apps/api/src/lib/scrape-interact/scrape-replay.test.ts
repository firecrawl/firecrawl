import {
  buildReplayContextFromScrape,
  buildReplayScript,
} from "./scrape-replay";

describe("scrape replay", () => {
  it("drops executeJavascript actions from replay context", () => {
    const replay = buildReplayContextFromScrape({
      id: "scrape-id",
      team_id: "team-id",
      url: "https://example.com",
      options: {
        waitFor: 250,
        actions: [
          { type: "wait", milliseconds: 100 },
          {
            type: "executeJavascript",
            script: "window.__firecrawlReplayMarker = 'pwned';",
          },
          { type: "click", selector: "a[href='/about']" },
        ],
      },
    });

    expect(replay.error).toBeUndefined();
    expect(replay.context).toBeDefined();
    expect(replay.context?.actions).toEqual([
      { type: "wait", milliseconds: 100 },
      { type: "click", selector: "a[href='/about']", all: false },
    ]);
  });

  it("never emits eval-based javascript replay code", () => {
    const script = buildReplayScript({
      targetUrl: "https://example.com",
      waitForMs: 0,
      actions: [{ type: "click", selector: "a[href='/about']", all: false }],
    });

    expect(script).not.toMatch(/\beval\s*\(/);
    expect(script).not.toContain("executeJavascript");
  });
});
