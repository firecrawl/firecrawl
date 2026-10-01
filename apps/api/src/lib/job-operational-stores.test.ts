import { vi } from "vitest";
import type { MutationConstructorObj } from "@google-cloud/bigtable";

const {
  mutate,
  getRows,
  getBigtableTable,
  mutableConfig,
  setSpanAttributes,
  withSpan,
  spans,
} = vi.hoisted(() => {
  const spans: { name: string; options: any }[] = [];
  return {
    mutate: vi.fn<(mutations: MutationConstructorObj[]) => Promise<void>>(
      async () => {},
    ),
    getRows: vi.fn(async () => [[]]),
    setSpanAttributes: vi.fn(),
    getBigtableTable: vi.fn(),
    mutableConfig: {
      BIGTABLE_JOB_ACCESS_TABLE: "job-access",
      BIGTABLE_FEEDBACK_JOBS_TABLE: "feedback-jobs",
      SEARCH_FEEDBACK_MAX_AGE_SEC: 120,
      FEEDBACK_MAX_AGE_SEC: 180,
    } as {
      BIGTABLE_JOB_ACCESS_TABLE?: string;
      BIGTABLE_FEEDBACK_JOBS_TABLE?: string;
      SEARCH_FEEDBACK_MAX_AGE_SEC: number;
      FEEDBACK_MAX_AGE_SEC: number;
    },
    withSpan: vi.fn(
      async (name: string, fn: (span: any) => any, options?: any) => {
        spans.push({ name, options });
        return fn({});
      },
    ),
    spans,
  };
});

vi.mock("../config", () => ({ config: mutableConfig }));
vi.mock("./bigtable-client", () => ({ getBigtableTable }));
vi.mock("./otel-tracer", () => ({
  withSpan,
  setSpanAttributes,
}));

import {
  API_JOB_KINDS,
  isApiJobKind,
  readApiJobAccess,
  writeApiJobAccess,
} from "./job-access-store";
import { readFeedbackJob, writeFeedbackJob } from "./feedback-job-store";
import { saltedUuidV7RowKey } from "./bigtable-row-key";
import { scrapeOptions } from "../controllers/v2/types";

const JOB_ID = "019e6f45-7778-727d-adf0-0abe9d5062b6";
const REQUEST_ID = "019e6f45-7778-727d-adf0-0abe9d5062b7";

function writtenValue(): Record<string, string | number | boolean> {
  const mutation = mutate.mock.calls[0][0][0];
  return JSON.parse(
    mutation.data.j?.v?.value ?? mutation.data.f.v.value,
  ) as Record<string, string | number | boolean>;
}

describe("operational Bigtable stores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBigtableTable.mockResolvedValue({ mutate, getRows });
    mutableConfig.BIGTABLE_JOB_ACCESS_TABLE = "job-access";
    mutableConfig.BIGTABLE_FEEDBACK_JOBS_TABLE = "feedback-jobs";
    spans.length = 0;
  });

  it("salts UUIDv7 row keys while preserving compact binary ids", () => {
    const key = saltedUuidV7RowKey(JOB_ID);
    expect(key).toHaveLength(24);
    expect(key.slice(0, 2)).toMatch(/^[0-9a-f]{2}$/);
    expect(Buffer.from(key.slice(2), "base64url").toString("hex")).toBe(
      JOB_ID.replaceAll("-", ""),
    );
    expect(() =>
      saltedUuidV7RowKey("550e8400-e29b-41d4-a716-446655440000"),
    ).toThrow("Expected a UUIDv7 row id");
  });

  it("writes an acknowledged job access row", async () => {
    const expiresAt = new Date("2026-09-16T12:00:00.000Z");
    await expect(
      writeApiJobAccess({
        id: JOB_ID,
        teamId: "team-id",
        kind: "agent",
        expiresAt,
        clientOrigin: "python-sdk@4.36.0",
      }),
    ).resolves.toBe(true);

    expect(getBigtableTable).toHaveBeenCalledWith("job-access");
    expect(writtenValue()).toEqual({
      version: 1,
      teamId: "team-id",
      kind: "agent",
      expiresAtMs: expiresAt.getTime(),
      clientOrigin: "python-sdk@4.36.0",
    });
    expect(mutate.mock.calls[0][0][0].data.j.v.timestamp).toEqual(expiresAt);
    expect(spans).toContainEqual({
      name: "bigtable.job_access.write",
      options: { zeroDataRetention: undefined },
    });
  });

  it("reads a job access row", async () => {
    getRows.mockResolvedValueOnce([
      [
        {
          data: {
            j: {
              v: [
                {
                  value: Buffer.from(
                    JSON.stringify({
                      version: 1,
                      teamId: "team-id",
                      kind: "crawl",
                      expiresAtMs: Date.now() + 60_000,
                    }),
                  ),
                },
              ],
            },
          },
        },
      ],
    ] as any);

    await expect(readApiJobAccess(JOB_ID)).resolves.toMatchObject({
      teamId: "team-id",
      kind: "crawl",
    });
    expect(getRows).toHaveBeenCalledWith({
      keys: [saltedUuidV7RowKey(JOB_ID)],
      filter: [{ column: { name: "v", cellLimit: 1 } }],
    });
  });

  it("reports a logically expired job access row", async () => {
    const expiresAtMs = Date.now() - 1;
    getRows.mockResolvedValueOnce([
      [
        {
          data: {
            j: {
              v: [
                {
                  value: Buffer.from(
                    JSON.stringify({
                      version: 1,
                      teamId: "team-id",
                      kind: "crawl",
                      expiresAtMs,
                    }),
                  ),
                },
              ],
            },
          },
        },
      ],
    ] as any);

    await expect(readApiJobAccess(JOB_ID)).resolves.toMatchObject({
      expiresAtMs,
    });
    expect(setSpanAttributes).toHaveBeenCalledWith(expect.anything(), {
      "bigtable.read.outcome": "expired",
    });
  });

  it("limits job access rows to externally operable job kinds", () => {
    expect(API_JOB_KINDS).toEqual([
      "scrape",
      "crawl",
      "batch_scrape",
      "extract",
      "agent",
      "llmstxt",
      "deep_research",
    ]);
    expect(API_JOB_KINDS.every(isApiJobKind)).toBe(true);
    expect(
      [
        "search",
        "map",
        "parse",
        "browser",
        "interact",
        "research_paper_search",
        "research_paper_inspect",
        "research_paper_read",
        "research_related_papers",
        "research_github_search",
        "code_search",
      ].some(isApiJobKind),
    ).toBe(false);
  });

  it("does not initialize Bigtable when a store is disabled", async () => {
    mutableConfig.BIGTABLE_JOB_ACCESS_TABLE = undefined;
    await expect(
      writeApiJobAccess({
        id: JOB_ID,
        teamId: "team-id",
        kind: "scrape",
        expiresAt: new Date(),
      }),
    ).resolves.toBe(false);
    expect(getBigtableTable).not.toHaveBeenCalled();
  });

  it("writes only the precomputed feedback decision inputs", async () => {
    const completedAt = new Date("2026-09-15T12:00:00.000Z");
    await expect(
      writeFeedbackJob({
        jobId: JOB_ID,
        requestId: REQUEST_ID,
        teamId: "team-id",
        endpoint: "scrape",
        scrapeOptions: scrapeOptions.parse({
          parsers: ["pdf"],
          formats: [
            { type: "json", schema: {} },
            { type: "screenshot", fullPage: false },
          ],
          actions: [{ type: "click", selector: "button", all: false }],
        }),
        succeeded: true,
        creditsBilled: 12,
        zeroDataRetention: false,
        completedAt,
      }),
    ).resolves.toBe(true);

    expect(getBigtableTable).toHaveBeenCalledWith("feedback-jobs");
    expect(writtenValue()).toEqual({
      version: 1,
      requestId: REQUEST_ID,
      teamId: "team-id",
      refundClass: "scrape_pdf",
      feedbackDeadlineMs: completedAt.getTime() + 180_000,
      succeeded: true,
      creditsBilled: 12,
      zeroDataRetention: false,
    });
    expect(mutate.mock.calls[0][0][0].data.f.v.timestamp).toEqual(
      new Date(completedAt.getTime() + 24 * 60 * 60 * 1000),
    );
    expect(spans).toContainEqual({
      name: "bigtable.feedback_job.write",
      options: { zeroDataRetention: false },
    });
  });

  it("keeps the row past a feedback window longer than the default retention", async () => {
    const completedAt = new Date("2026-09-15T12:00:00.000Z");
    const original = mutableConfig.FEEDBACK_MAX_AGE_SEC;
    mutableConfig.FEEDBACK_MAX_AGE_SEC = 30 * 60 * 60; // 30 h, past the 24 h default
    try {
      await writeFeedbackJob({
        jobId: JOB_ID,
        requestId: REQUEST_ID,
        teamId: "team-id",
        endpoint: "scrape",
        scrapeOptions: scrapeOptions.parse({}),
        succeeded: true,
        creditsBilled: 1,
        zeroDataRetention: false,
        completedAt,
      });
    } finally {
      mutableConfig.FEEDBACK_MAX_AGE_SEC = original;
    }

    expect(writtenValue()).toMatchObject({
      feedbackDeadlineMs: completedAt.getTime() + 30 * 60 * 60 * 1000,
    });
    // window + one hour of margin, not the flat 24 h
    expect(mutate.mock.calls[0][0][0].data.f.v.timestamp).toEqual(
      new Date(completedAt.getTime() + 31 * 60 * 60 * 1000),
    );
  });

  it("uses the search-specific feedback window", async () => {
    const completedAt = new Date("2026-09-15T12:00:00.000Z");
    await writeFeedbackJob({
      jobId: JOB_ID,
      requestId: JOB_ID,
      teamId: "team-id",
      endpoint: "search",
      succeeded: false,
      creditsBilled: 0,
      zeroDataRetention: true,
      completedAt,
    });

    expect(writtenValue()).toMatchObject({
      refundClass: "search",
      feedbackDeadlineMs: completedAt.getTime() + 120_000,
      succeeded: false,
      zeroDataRetention: true,
    });
    expect(spans).toContainEqual({
      name: "bigtable.feedback_job.write",
      options: { zeroDataRetention: true },
    });
  });

  it("reads precomputed feedback decisions", async () => {
    const feedbackDeadlineMs = Date.now() + 60_000;
    getRows.mockResolvedValueOnce([
      [
        {
          data: {
            f: {
              v: [
                {
                  value: Buffer.from(
                    JSON.stringify({
                      version: 1,
                      requestId: REQUEST_ID,
                      teamId: "team-id",
                      refundClass: "scrape_pdf",
                      feedbackDeadlineMs,
                      succeeded: true,
                      creditsBilled: 12,
                      zeroDataRetention: false,
                    }),
                  ),
                },
              ],
            },
          },
        },
      ],
    ] as any);

    await expect(readFeedbackJob(JOB_ID)).resolves.toEqual({
      requestId: REQUEST_ID,
      teamId: "team-id",
      refundClass: "scrape_pdf",
      feedbackDeadlineMs,
      succeeded: true,
      creditsBilled: 12,
      zeroDataRetention: false,
    });
  });

  it("reports a logically expired feedback decision", async () => {
    const feedbackDeadlineMs = Date.now() - 1;
    getRows.mockResolvedValueOnce([
      [
        {
          data: {
            f: {
              v: [
                {
                  value: Buffer.from(
                    JSON.stringify({
                      version: 1,
                      requestId: REQUEST_ID,
                      teamId: "team-id",
                      refundClass: "search",
                      feedbackDeadlineMs,
                      succeeded: true,
                      creditsBilled: 1,
                      zeroDataRetention: false,
                    }),
                  ),
                },
              ],
            },
          },
        },
      ],
    ] as any);

    await expect(readFeedbackJob(JOB_ID)).resolves.toMatchObject({
      feedbackDeadlineMs,
    });
    expect(setSpanAttributes).toHaveBeenCalledWith(expect.anything(), {
      "bigtable.read.outcome": "expired",
    });
  });
});
