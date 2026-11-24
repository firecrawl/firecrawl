vi.mock("uuid", () => ({
  v7: vi.fn(() => "job-1"),
}));

import { describe, expect, it, vi } from "vitest";
import { scrapeSearchResults } from "./scrape";
import { processJobInternal } from "../services/worker/scrape-worker";
import { defaultModules, noLimits } from "../service/defaults";
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
});
