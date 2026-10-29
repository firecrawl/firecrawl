import type { Logger } from "winston";
import {
  type SearchVerdict,
  verdictJsonSchema,
  buildJudgePrompt,
} from "./judge";
import { canonicalizeUrl, stableSerpFingerprint } from "./dedupe";
import { hashMonitorUrl } from "../store";
import { scrapeRequestSchema } from "../../../controllers/v2/types";

// vi.mock is hoisted above declarations, so the mocks its factories reference
// are created in vi.hoisted() (also hoisted) to avoid any TDZ surprises.
const { searchMock, scrapePageMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  scrapePageMock: vi.fn(),
}));

vi.mock("uuid", () => ({ v7: () => "00000000-0000-7000-8000-000000000000" }));
vi.mock("../../../search/v2", () => ({
  // Tests set the mock to resolve a bare result array; the real search() returns
  // a SearchV2Response ({ web: [...] }), so wrap arrays to match that contract.
  search: async (...a: unknown[]) => {
    const r = await searchMock(...a);
    return Array.isArray(r) ? { web: r } : r;
  },
}));
// Deep mode (these tests) scrapes + parses a per-page JSON verdict and dedups by
// canonical URL — the only LLM stage is the injected per-page scrape verdict.
vi.mock("./tuning", () => ({
  hasLlmProvider: () => false,
  googleProviderOptions: () => ({}),
}));

import { runSearchTarget, type KnownPage } from "./run";

const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const verdict = (over: Partial<SearchVerdict> = {}): SearchVerdict => ({
  relevant: true,
  alertAction: "alert",
  concept: "openai-ipo",
  rationale: "filing confirmed",
  ...over,
});

const okScrape = (v: SearchVerdict) => ({
  json: v,
  markdown: "",
  metadata: {},
});

function setSearchResults(
  results: Array<{ url: string; title: string; description: string }>,
) {
  searchMock.mockResolvedValue(results);
}

function setVerdictsByUrl(map: Record<string, SearchVerdict>) {
  scrapePageMock.mockImplementation(({ url }: { url: string }) => {
    const v = map[url];
    if (!v) return Promise.resolve(null);
    return Promise.resolve(okScrape(v));
  });
}

const baseTarget = {
  id: "t1",
  queries: ["openai ipo"],
  searchWindow: "24h",
  alertMode: "first_match" as const,
  maxResults: 10,
};

const baseMonitor = {
  id: "m1",
  teamId: "team1",
  goal: "Alert when OpenAI files for IPO",
  subject: "OpenAI",
  judgeEnabled: true,
};

function run(
  over: {
    target?: Partial<typeof baseTarget> & { recheckAfter?: string };
    knownPages?: Map<string, KnownPage>;
    knownEvents?: { key: string; label: string }[];
    goalVersion?: string;
    alertMode?: "first_match" | "every_new_result" | "material_dev";
    isBlocked?: (url: string) => boolean;
  } = {},
) {
  return runSearchTarget({
    monitor: baseMonitor,
    target: {
      ...baseTarget,
      ...over.target,
      alertMode: over.alertMode ?? baseTarget.alertMode,
    },
    monitorCheckId: "check-1",
    scrapePage: (...a: unknown[]) => scrapePageMock(...a),
    isBlocked: over.isBlocked,
    goalVersion: over.goalVersion ?? "gv1",
    knownPages: over.knownPages ?? new Map(),
    knownEvents: over.knownEvents ?? [],
    zeroDataRetention: false,
    logger,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSearchTarget orchestration", () => {
  it("alerts on a new, relevant, fresh result", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    setVerdictsByUrl({ "https://sec.gov/openai": verdict() });

    const out = await run();

    expect(out.matches).toBe(1);
    expect(out.sources[0].status).toBe("alert");
    expect(out.sources[0].eventKey).toBeTruthy();
    expect(out.pageUpserts[0].status).toBe("alert");
    expect(out.summary).toBe("1 match across 1 result.");
    expect(scrapePageMock).toHaveBeenCalledTimes(1);
  });

  it("preserves original URL case in the stored page (paths/query params are case-sensitive)", async () => {
    const mixedUrl = "https://example.com/watch?v=DAlfGz8tPc4";
    setSearchResults([
      { url: mixedUrl, title: "OpenAI reel", description: "clip" },
    ]);
    setVerdictsByUrl({ [mixedUrl]: verdict() });

    const out = await run();

    expect(out.pageUpserts[0].url).toBe(mixedUrl);
    expect(out.sources[0].url).toBe(mixedUrl);
    expect(out.pageUpserts[0].urlHash).toEqual(
      hashMonitorUrl(canonicalizeUrl(mixedUrl)),
    );
  });

  it("skips scrape/judge for an already-seen unchanged page (same goalVersion)", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    const canonical = canonicalizeUrl("https://sec.gov/openai");
    const fingerprint = stableSerpFingerprint({
      url: "https://sec.gov/openai",
      title: "OpenAI S-1",
      snippet: "filing",
    });
    const knownPages = new Map<string, KnownPage>([
      [canonical, { fingerprint, goalVersion: "gv1", lastStatus: "alert" }],
    ]);

    const out = await run({ knownPages });

    expect(out.sources[0].status).toBe("already_seen");
    expect(out.pageUpserts[0].status).toBe("already_seen");
    expect(scrapePageMock).not.toHaveBeenCalled();
    expect(out.matches).toBe(0);
  });

  it("reuse upsert preserves prior event metadata (eventKey survives unchanged pages)", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    const canonical = canonicalizeUrl("https://sec.gov/openai");
    const fingerprint = stableSerpFingerprint({
      url: "https://sec.gov/openai",
      title: "OpenAI S-1",
      snippet: "filing",
    });
    const knownPages = new Map<string, KnownPage>([
      [
        canonical,
        {
          fingerprint,
          goalVersion: "gv1",
          lastStatus: "alert",
          metadata: {
            fingerprint,
            goalVersion: "gv1",
            searchStatus: "alert",
            eventKey: "evt-1",
            eventLabel: "OpenAI IPO",
            eventSatisfiedAt: "2026-06-01T00:00:00Z",
            eventAlertCount: 2,
          },
        },
      ],
    ]);

    const out = await run({ knownPages });

    expect(scrapePageMock).not.toHaveBeenCalled();
    expect(out.pageUpserts[0].status).toBe("already_seen");
    expect(out.pageUpserts[0].metadata).toMatchObject({
      eventKey: "evt-1",
      eventLabel: "OpenAI IPO",
      eventSatisfiedAt: "2026-06-01T00:00:00Z",
      eventAlertCount: 2,
      fingerprint,
      goalVersion: "gv1",
      searchStatus: "already_seen",
    });
  });

  it("mirrors the search-internal status into metadata and marks deep judgments scraped", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
      {
        url: "https://old.com/openai",
        title: "OpenAI old news",
        description: "2019",
      },
      {
        url: "https://spam.com/x",
        title: "irrelevant",
        description: "noise",
      },
    ]);
    setVerdictsByUrl({
      "https://sec.gov/openai": verdict(),
      "https://old.com/openai": verdict({ alertAction: "watch" }),
      "https://spam.com/x": verdict({ relevant: false }),
    });

    const out = await run();

    const byStatus = (status: string) =>
      out.pageUpserts.find(u => u.status === status)!;
    for (const status of ["alert", "watching", "ignored"]) {
      expect(byStatus(status).metadata.searchStatus).toBe(status);
      expect(byStatus(status).scraped).toBe(true);
    }
    expect(byStatus("alert").judgment).toMatchObject({
      meaningful: true,
      reason: "filing confirmed",
      meaningfulChanges: [],
    });
    expect(byStatus("watching").judgment).toMatchObject({
      meaningful: false,
      reason: "filing confirmed",
      meaningfulChanges: [],
    });
    expect(byStatus("ignored").judgment).toMatchObject({
      meaningful: false,
      reason: "filing confirmed",
      meaningfulChanges: [],
    });
  });

  it("re-evaluates a known page when the goalVersion changed (stale memory)", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    setVerdictsByUrl({ "https://sec.gov/openai": verdict() });
    const canonical = canonicalizeUrl("https://sec.gov/openai");
    const fingerprint = stableSerpFingerprint({
      url: "https://sec.gov/openai",
      title: "OpenAI S-1",
      snippet: "filing",
    });
    const knownPages = new Map<string, KnownPage>([
      [canonical, { fingerprint, goalVersion: "gv1" }],
    ]);

    const out = await run({ knownPages, goalVersion: "gv2" });

    expect(scrapePageMock).toHaveBeenCalledTimes(1);
    expect(out.sources[0].status).toBe("alert");
  });

  it("first_match: suppresses a result whose URL is an already-satisfied event", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    setVerdictsByUrl({ "https://sec.gov/openai": verdict() });
    const canonical = canonicalizeUrl("https://sec.gov/openai");

    const out = await run({
      alertMode: "first_match",
      knownEvents: [{ key: canonical, label: "OpenAI IPO" }],
    });

    expect(out.matches).toBe(0);
    expect(out.sources[0].status).toBe("already_seen");
    // the suppressed result was still deep-scraped and judged
    const seen = out.pageUpserts.find(u => u.status === "already_seen")!;
    expect(seen.scraped).toBe(true);
    expect(seen.metadata.searchStatus).toBe("already_seen");
    expect(seen.judgment).toMatchObject({
      meaningful: true,
      reason: "filing confirmed",
      meaningfulChanges: [],
    });
  });

  it("uses the canonical URL as the event key (label is the verdict concept)", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    setVerdictsByUrl({
      "https://sec.gov/openai": verdict({ concept: "OpenAI IPO filing" }),
    });
    const out = await run();
    expect(out.sources[0].eventKey).toBe(
      canonicalizeUrl("https://sec.gov/openai"),
    );
    expect(out.pageUpserts[0].metadata.eventLabel).toBe("OpenAI IPO filing");
  });

  it("every_new_result: re-alerts a URL that is already a known event", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    setVerdictsByUrl({ "https://sec.gov/openai": verdict() });
    const canonical = canonicalizeUrl("https://sec.gov/openai");

    const out = await run({
      alertMode: "every_new_result",
      knownEvents: [{ key: canonical, label: "OpenAI IPO" }],
    });

    expect(out.matches).toBe(1);
    expect(out.sources[0].status).toBe("alert");
  });

  it("keeps a judge-watched (e.g. old-news) verdict at watch (no notify)", async () => {
    setSearchResults([
      {
        url: "https://old.com/openai",
        title: "OpenAI old news",
        description: "2019",
      },
    ]);
    setVerdictsByUrl({
      "https://old.com/openai": verdict({ alertAction: "watch" }),
    });

    const out = await run();

    expect(out.sources[0].status).toBe("watching");
    expect(out.matches).toBe(0);
  });

  it("marks a result skipped when the scrape fails", async () => {
    setSearchResults([
      { url: "https://dead.com/x", title: "x", description: "y" },
    ]);
    scrapePageMock.mockResolvedValue(null);

    const out = await run();

    expect(out.sources[0].status).toBe("skipped");
    expect(out.skipped).toBe(1);
    expect(out.matches).toBe(0);
  });

  it("dedups the same canonical URL returned by two queries", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
      {
        url: "https://www.SEC.gov/openai/",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    setVerdictsByUrl({ "https://sec.gov/openai": verdict() });

    const out = await run();

    expect(out.resultCount).toBe(1);
    expect(scrapePageMock).toHaveBeenCalledTimes(1);
  });
});

describe("scrape payload validity (real validator, no mocks)", () => {
  it("scrapeRequestSchema accepts the verdict json format the runner sends", () => {
    const parsed = scrapeRequestSchema.parse({
      url: "https://example.com",
      formats: [
        {
          type: "json",
          schema: verdictJsonSchema,
          prompt: buildJudgePrompt("goal", "subject", "24h"),
        },
      ],
      timeout: 20000,
      origin: "monitor",
    });
    const jsonFormat = (parsed.formats as Array<{ type: string }>).find(
      f => f.type === "json",
    );
    expect(jsonFormat).toBeTruthy();
    expect((jsonFormat as { prompt?: string }).prompt).toContain("goal");
  });
});

describe("material_dev alert mode (dedups a known URL like first_match)", () => {
  const url = "https://reuters.com/openai";
  const serp = [{ url, title: "OpenAI prices IPO", description: "priced" }];
  beforeEach(() => {
    setSearchResults(serp);
    setVerdictsByUrl({ [url]: verdict() });
  });

  it("alerts on a URL not yet seen", async () => {
    const out = await run({ alertMode: "material_dev" });
    expect(out.matches).toBe(1);
    expect(out.sources[0].status).toBe("alert");
  });

  it("suppresses a URL that is already a known event", async () => {
    const out = await run({
      alertMode: "material_dev",
      knownEvents: [{ key: canonicalizeUrl(url), label: "OpenAI IPO" }],
    });
    expect(out.matches).toBe(0);
    expect(out.sources[0].status).toBe("already_seen");
  });
});

describe("re-judge cadence", () => {
  const url = "https://sec.gov/openai";
  const fp = stableSerpFingerprint({
    url,
    title: "OpenAI S-1",
    snippet: "filing",
  });
  const serp = [{ url, title: "OpenAI S-1", description: "filing" }];
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  const recent = new Date(Date.now() - 1000).toISOString();

  it("re-judges a live page whose last check is older than recheckAfter (SERP unchanged)", async () => {
    setSearchResults(serp);
    setVerdictsByUrl({ [url]: verdict() });
    const knownPages = new Map<string, KnownPage>([
      [
        canonicalizeUrl(url),
        {
          fingerprint: fp,
          goalVersion: "gv1",
          lastCheckedAt: old,
          lastStatus: "watching",
        },
      ],
    ]);
    const out = await run({ target: { recheckAfter: "24h" }, knownPages });
    expect(scrapePageMock).toHaveBeenCalledTimes(1);
    expect(out.sources[0].status).toBe("alert");
  });

  it("does NOT re-judge when the last check is within recheckAfter", async () => {
    setSearchResults(serp);
    setVerdictsByUrl({ [url]: verdict() });
    const knownPages = new Map<string, KnownPage>([
      [
        canonicalizeUrl(url),
        {
          fingerprint: fp,
          goalVersion: "gv1",
          lastCheckedAt: recent,
          lastStatus: "watching",
        },
      ],
    ]);
    const out = await run({ target: { recheckAfter: "24h" }, knownPages });
    expect(scrapePageMock).not.toHaveBeenCalled();
    expect(out.sources[0].status).toBe("watching");
  });
});

describe("domain scoping", () => {
  beforeEach(() => setSearchResults([]));

  it("includeDomains and excludeDomains combine; exclude wins in the query", async () => {
    await run({
      target: {
        includeDomains: ["reuters.com", "spam.example"],
        excludeDomains: ["spam.example"],
      } as Partial<typeof baseTarget>,
    });
    const sentQuery = searchMock.mock.calls[0][0].query as string;
    expect(sentQuery).toContain("(site:reuters.com OR site:spam.example)");
    expect(sentQuery).toContain("-site:spam.example");
  });

  it("excluded hosts returned by the provider are dropped before judging", async () => {
    setSearchResults([
      {
        url: "https://www.pinterest.com/pin/1",
        title: "pin",
        description: "x",
      },
      {
        url: "https://boards.pinterest.com/pin/2",
        title: "pin",
        description: "x",
      },
      {
        url: "https://news.com/openai",
        title: "OpenAI files S-1",
        description: "x",
      },
    ]);
    setVerdictsByUrl({ "https://news.com/openai": verdict() });
    const out = await run({
      target: { excludeDomains: ["pinterest.com"] } as Partial<
        typeof baseTarget
      >,
    });
    expect(out.resultCount).toBe(1);
    expect(out.sources.map(s => s.url)).toEqual(["https://news.com/openai"]);
    expect(scrapePageMock).toHaveBeenCalledTimes(1);
  });

  it("blocklisted URLs are dropped before scrape/judge/billing", async () => {
    setSearchResults([
      { url: "https://blocked.com/x", title: "blocked", description: "x" },
      {
        url: "https://news.com/openai",
        title: "OpenAI files S-1",
        description: "x",
      },
    ]);
    setVerdictsByUrl({ "https://news.com/openai": verdict() });
    const out = await run({
      isBlocked: url => url.includes("blocked.com"),
    });
    expect(out.resultCount).toBe(1);
    expect(out.sources.map(s => s.url)).toEqual(["https://news.com/openai"]);
    expect(out.pageUpserts.map(p => p.url)).toEqual([
      "https://news.com/openai",
    ]);
    expect(scrapePageMock).toHaveBeenCalledTimes(1);
    expect(out.resultsJudged).toBe(1);
  });
});
