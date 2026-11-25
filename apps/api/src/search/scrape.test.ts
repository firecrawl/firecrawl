vi.mock("uuid", () => ({
  v7: vi.fn(() => "job-1"),
}));

import { describe, expect, it, vi } from "vitest";
import { getItemsToScrape, scrapeSearchResults } from "./scrape";
import { processJobInternal } from "../services/worker/scrape-worker";
import { defaultModules, noBlocklist, noLimits } from "../service/defaults";
import type { CoreParts } from "../service/service";
import { testService, withService } from "../service/testing";

vi.mock("../services/worker/scrape-worker", () => ({
  processJobInternal: vi.fn().mockResolvedValue({
    markdown: "body",
    metadata: { creditsUsed: 1, statusCode: 200, proxyUsed: "basic" },
  }),
}));

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

describe("scrapeSearchResults", () => {
  it("preserves billing metadata and uses limits.jobPriority on spawned scrape jobs", async () => {
    const jobPriority = vi.fn().mockResolvedValue(17);

    await withService(
      testService(defaultModules(), parts, {
        limits: {
          ...noLimits(),
          jobPriority,
        },
      }),
      async () => {
        await scrapeSearchResults(
          [
            {
              url: "https://example.com",
              title: "Example",
              description: "Desc",
            },
          ],
          {
            teamId: "team-1",
            origin: "api",
            timeout: 60_000,
            scrapeOptions: {} as any,
            apiKeyId: 123,
            requestId: "req-1",
            billing: { endpoint: "agent" },
          },
          { debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
          null as any,
        );
      },
    );

    expect(jobPriority).toHaveBeenCalledWith({
      ctx: {
        teamId: "team-1",
        zeroDataRetention: false,
        flags: null,
        orgId: null,
        apiKeyId: 123,
        billing: { endpoint: "agent" },
      },
      base: 10,
    });
    expect(processJobInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 17,
        data: expect.objectContaining({
          billing: { endpoint: "agent" },
        }),
      }),
    );
  });

  it("puts the request context on spawned scrape jobs", async () => {
    await scrapeSearchResults(
      [
        {
          url: "https://example.com",
          title: "Example",
          description: "Desc",
        },
      ],
      {
        teamId: "team-1",
        orgId: "org-1",
        origin: "api",
        timeout: 60_000,
        scrapeOptions: {} as any,
        apiKeyId: 123,
        zeroDataRetention: true,
        billing: { endpoint: "search" },
      },
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
      { checkRobotsOnScrape: true },
    );

    expect(processJobInternal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        priority: 10,
        data: expect.objectContaining({
          ctx: {
            teamId: "team-1",
            zeroDataRetention: true,
            flags: { checkRobotsOnScrape: true },
            orgId: "org-1",
            apiKeyId: 123,
            billing: { endpoint: "search" },
          },
          team_id: "team-1",
          zeroDataRetention: true,
          apiKeyId: 123,
          billing: { endpoint: "search" },
          internalOptions: expect.objectContaining({
            orgId: "org-1",
            teamFlags: { checkRobotsOnScrape: true },
          }),
        }),
      }),
    );
  });
  it("enforces forced scrape ZDR and dual-writes threatProtection on child scrapes", async () => {
    const parentCtx = {
      teamId: "team-zdr",
      zeroDataRetention: false,
      flags: { scrapeZDR: "forced" },
      orgId: "org-zdr",
      apiKeyId: 55,
      billing: { endpoint: "search" as const, jobId: "search-1" },
      policy: { threatProtection: { mode: "block" } },
    } as any;

    await scrapeSearchResults(
      [
        {
          url: "https://example.com",
          title: "Example",
          description: "Desc",
        },
      ],
      {
        teamId: "team-zdr",
        orgId: "org-zdr",
        origin: "api",
        timeout: 60_000,
        scrapeOptions: {} as any,
        apiKeyId: 55,
        zeroDataRetention: false,
        billing: { endpoint: "search", jobId: "search-1" },
        ctx: parentCtx,
      },
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
      { scrapeZDR: "forced" } as any,
    );

    expect(processJobInternal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          zeroDataRetention: true,
          ctx: expect.objectContaining({
            teamId: "team-zdr",
            zeroDataRetention: true,
            billing: { endpoint: "search", jobId: "search-1" },
          }),
          internalOptions: expect.objectContaining({
            zeroDataRetention: true,
            threatProtection: { mode: "block" },
          }),
        }),
      }),
    );
  });
});

describe("getItemsToScrape", () => {
  const parts = { core: { name: "core" }, logger: { error: vi.fn() } };
  const sampleResults = {
    web: [
      { url: "https://allowed.example/a", title: "A", description: "a" },
      { url: "https://blocked.example/b", title: "B", description: "b" },
    ],
    news: [
      { url: "https://blocked.example/n", title: "N", snippet: "n" },
      { url: "https://allowed.example/n", title: "N2", snippet: "n2" },
    ],
    images: [
      { url: "https://allowed.example/i.png", title: "I" },
      { url: "https://blocked.example/i.png", title: "I2" },
    ],
  };

  it("keeps all items under noBlocklist()", async () => {
    await withService(testService(defaultModules(), parts), async () => {
      const items = getItemsToScrape(sampleResults as any, null, {
        team_id: "team-1",
        org_id: "org-1",
        origin: "search",
      });
      expect(items.map(i => i.scrapeInput.url)).toEqual([
        "https://allowed.example/a",
        "https://blocked.example/b",
        "https://blocked.example/n",
        "https://allowed.example/n",
        "https://allowed.example/i.png",
        "https://blocked.example/i.png",
      ]);
    });
  });

  it("filters URLs blocked by the installed blocklist module and disables recording when context is omitted", async () => {
    const isBlocked = vi.fn(
      (url: string) => new URL(url).hostname === "blocked.example",
    );

    await withService(
      testService(defaultModules(), parts, {
        blocklist: { ...noBlocklist(), isBlocked },
      }),
      async () => {
        const items = getItemsToScrape(sampleResults as any, null, {
          team_id: "team-1",
          org_id: "org-1",
          origin: "search",
        });
        expect(items.map(i => i.scrapeInput.url)).toEqual([
          "https://allowed.example/a",
          "https://allowed.example/n",
          "https://allowed.example/i.png",
        ]);
        expect(isBlocked).toHaveBeenCalledWith(
          "https://blocked.example/b",
          expect.objectContaining({ teamId: "team-1", orgId: "org-1" }),
          { origin: "search" },
        );

        isBlocked.mockClear();
        getItemsToScrape(
          {
            web: [{ url: "https://allowed.example/a", title: "A" }],
          } as any,
          null,
        );
        expect(isBlocked).toHaveBeenCalledWith(
          "https://allowed.example/a",
          expect.objectContaining({ teamId: "", orgId: null }),
          { record: false },
        );
      },
    );
  });
});
