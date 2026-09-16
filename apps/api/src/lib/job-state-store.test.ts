import { vi } from "vitest";
import type { MutationConstructorObj } from "@google-cloud/bigtable";

const { mutate, getRows, getBigtableTable, mutableConfig, withSpan } =
  vi.hoisted(() => ({
    mutate: vi.fn<(mutations: MutationConstructorObj[]) => Promise<void>>(
      async () => {},
    ),
    getRows: vi.fn(async () => [[]]),
    getBigtableTable: vi.fn(),
    mutableConfig: {
      BIGTABLE_JOB_ACCESS_TABLE: "api-job-access",
    } as { BIGTABLE_JOB_ACCESS_TABLE?: string },
    withSpan: vi.fn(
      async (_name: string, fn: (span: any) => any) => await fn({}),
    ),
  }));

vi.mock("../config", () => ({ config: mutableConfig }));
vi.mock("./bigtable-client", () => ({ getBigtableTable }));
vi.mock("./otel-tracer", () => ({
  withSpan,
  setSpanAttributes: vi.fn(),
}));

import {
  readExtractJobState,
  readScrapeJobState,
  writeExtractJobState,
  writeScrapeJobState,
} from "./job-state-store";
import { saltedUuidV7RowKey } from "./bigtable-row-key";

const JOB_ID = "019e6f45-7778-727d-adf0-0abe9d5062b6";

function writtenValue(family: "scrape_state" | "extract_state") {
  const mutation = mutate.mock.calls[0][0][0];
  return JSON.parse(mutation.data[family].v.value.toString());
}

describe("Bigtable job state stores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutableConfig.BIGTABLE_JOB_ACCESS_TABLE = "api-job-access";
    getBigtableTable.mockResolvedValue({ mutate, getRows });
  });

  it("writes versioned scrape state to its own family", async () => {
    await writeScrapeJobState(JOB_ID, {
      status: "completed",
      requestId: JOB_ID,
      completedAtMs: 123,
      creditsBilled: 4,
      replay: { targetUrl: "https://example.com", waitForMs: 0, actions: [] },
    });

    expect(writtenValue("scrape_state")).toEqual({
      version: 1,
      status: "completed",
      requestId: JOB_ID,
      completedAtMs: 123,
      creditsBilled: 4,
      replay: { targetUrl: "https://example.com", waitForMs: 0, actions: [] },
    });
  });

  it("reads extract state from its own family", async () => {
    getRows.mockResolvedValueOnce([
      [
        {
          data: {
            extract_state: {
              v: [
                {
                  value: Buffer.from(
                    JSON.stringify({
                      version: 1,
                      status: "failed",
                      completedAtMs: 456,
                      creditsBilled: 2,
                      error: "failed",
                    }),
                  ),
                },
              ],
            },
          },
        },
      ],
    ] as any);

    await expect(readExtractJobState(JOB_ID)).resolves.toEqual({
      status: "failed",
      completedAtMs: 456,
      creditsBilled: 2,
      error: "failed",
    });
    expect(getRows).toHaveBeenCalledWith({
      keys: [saltedUuidV7RowKey(JOB_ID)],
      filter: [{ column: { name: "v", cellLimit: 1 } }],
    });
  });

  it("returns null when a state family is absent", async () => {
    await expect(readScrapeJobState(JOB_ID)).resolves.toBeNull();
  });

  it("does not initialize Bigtable when the table is disabled", async () => {
    mutableConfig.BIGTABLE_JOB_ACCESS_TABLE = undefined;
    await expect(
      writeExtractJobState(JOB_ID, {
        status: "completed",
        completedAtMs: 1,
        creditsBilled: 1,
      }),
    ).resolves.toBe(false);
    expect(getBigtableTable).not.toHaveBeenCalled();
  });
});
