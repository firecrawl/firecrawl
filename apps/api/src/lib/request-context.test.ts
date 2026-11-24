import { describe, expect, it } from "vitest";
import type { RequestContext } from "../service/request-context";
import type { ScrapeJobData } from "../types";
import type { StoredCrawl } from "./crawl-redis";
import {
  crawlContext,
  jobContext,
  requestContext,
  storedZeroDataRetention,
} from "./request-context";

const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const job = (fields: Record<string, unknown>) =>
  ({
    mode: "single_urls",
    url: "https://example.com",
    team_id: "team",
    zeroDataRetention: false,
    apiKeyId: null,
    ...fields,
  }) as ScrapeJobData;

const crawl = (fields: Record<string, unknown>) =>
  ({
    team_id: "team",
    createdAt: 0,
    crawlerOptions: null,
    internalOptions: { teamId: "team", orgId: null },
    ...fields,
  }) as StoredCrawl;

describe("requestContext", () => {
  it("is not zero data retention unless it is told so", () => {
    expect(
      requestContext({ teamId: "team", zeroDataRetention: undefined }),
    ).toMatchObject({ teamId: "team", zeroDataRetention: false });
    expect(
      requestContext({ teamId: "team", zeroDataRetention: true })
        .zeroDataRetention,
    ).toBe(true);
  });

  it("keeps the difference between no flags and unknown flags when stored", () => {
    const none = stored(
      requestContext({ teamId: "team", zeroDataRetention: false, flags: null }),
    );
    const unknown = stored(
      requestContext({ teamId: "team", zeroDataRetention: false }),
    );

    expect(none.flags).toBeNull();
    expect(unknown.flags).toBeUndefined();
    expect(unknown).toEqual({ teamId: "team", zeroDataRetention: false });
  });

  it("survives being stored", () => {
    const ctx = requestContext({
      teamId: "team",
      zeroDataRetention: true,
      flags: { checkRobotsOnScrape: true },
      orgId: "org",
      apiKeyId: 7,
      billing: { endpoint: "crawl", jobId: "crawl-1" },
    });

    expect(stored(ctx)).toEqual(ctx);
  });
});

describe("jobContext", () => {
  it("returns the payload's context as it is, unknown keys included", () => {
    const ctx = {
      teamId: "team",
      zeroDataRetention: true,
      flags: null,
      added: { by: "someone else" },
    } as RequestContext;
    const data = stored(
      job({ ctx, zeroDataRetention: false, internalOptions: { teamId: "x" } }),
    );

    expect(jobContext(data)).toEqual(ctx);
    expect(jobContext(stored({ ...data }))).toHaveProperty("added.by");
  });

  it("takes the same facts from the older fields of a payload without one", () => {
    const flags = { checkRobotsOnScrape: true };
    const billing = { endpoint: "scrape", jobId: "scrape-1" };

    expect(
      jobContext(
        stored(
          job({
            zeroDataRetention: true,
            apiKeyId: 7,
            billing,
            internalOptions: { teamId: "team", teamFlags: flags, orgId: "org" },
          }),
        ),
      ),
    ).toEqual({
      teamId: "team",
      zeroDataRetention: true,
      flags,
      orgId: "org",
      apiKeyId: 7,
      billing,
    });
  });

  it("keeps flags that were stored as none apart from flags that were never stored", () => {
    const none = job({ internalOptions: { teamId: "team", teamFlags: null } });
    const unknown = job({ internalOptions: { teamId: "team" } });
    const noOptions = job({});

    expect(jobContext(stored(none)).flags).toBeNull();
    expect(jobContext(stored(unknown)).flags).toBeUndefined();
    expect(jobContext(stored(noOptions)).flags).toBeUndefined();
  });

  it("reads a sitemap job, which has no internal options", () => {
    const data = stored(
      job({
        mode: "kickoff_sitemap",
        crawl_id: "crawl-1",
        sitemapUrl: "https://example.com/sitemap.xml",
        zeroDataRetention: true,
        apiKeyId: 7,
      }),
    );

    expect(jobContext(data)).toMatchObject({
      teamId: "team",
      zeroDataRetention: true,
      apiKeyId: 7,
    });
    expect(jobContext(data).flags).toBeUndefined();
  });
});

describe("crawlContext", () => {
  it("returns the record's context as it is, unknown keys included", () => {
    const ctx = {
      teamId: "team",
      zeroDataRetention: true,
      added: 1,
    } as RequestContext;

    expect(crawlContext(stored(crawl({ ctx })))).toEqual(ctx);
  });

  it("takes the same facts from the older fields of a record without one", () => {
    const flags = { checkRobotsOnScrape: true };
    const record = crawl({
      zeroDataRetention: true,
      internalOptions: { teamId: "team", orgId: "org", teamFlags: flags },
    });

    expect(crawlContext(stored(record))).toEqual({
      teamId: "team",
      zeroDataRetention: true,
      flags,
      orgId: "org",
    });
  });

  it("reads a record that never said whether it is zero data retention", () => {
    expect(crawlContext(stored(crawl({})))).toEqual({
      teamId: "team",
      zeroDataRetention: false,
      orgId: null,
    });
  });
});

describe("storedZeroDataRetention", () => {
  it("prefers the context over the older field", () => {
    const ctx = { teamId: "team", zeroDataRetention: true };

    expect(
      storedZeroDataRetention(stored(job({ ctx, zeroDataRetention: false }))),
    ).toBe(true);
    expect(storedZeroDataRetention(stored(crawl({ ctx })))).toBe(true);
  });

  it("reads the older field of a payload or record without a context", () => {
    expect(
      storedZeroDataRetention(stored(job({ zeroDataRetention: true }))),
    ).toBe(true);
    expect(
      storedZeroDataRetention(stored(crawl({ zeroDataRetention: true }))),
    ).toBe(true);
    expect(storedZeroDataRetention(stored(job({})))).toBe(false);
  });

  it("does not answer for a payload that does not say, or that is gone", () => {
    expect(storedZeroDataRetention(stored(crawl({})))).toBeUndefined();
    expect(storedZeroDataRetention({})).toBeUndefined();
    expect(storedZeroDataRetention(null)).toBeUndefined();
    expect(storedZeroDataRetention(undefined)).toBeUndefined();
  });
});
