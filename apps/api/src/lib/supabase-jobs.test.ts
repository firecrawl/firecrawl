import { vi } from "vitest";

const { dbRrSelect } = vi.hoisted(() => ({ dbRrSelect: vi.fn() }));

vi.mock("../db/connection", () => ({
  db: {},
  dbRr: { select: dbRrSelect },
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { logger } from "./logger";
import { supabaseGetScrapeById } from "./supabase-jobs";

// Mimics the drizzle chain used by the lookup: select().from().where().limit()
const selectChain = (result: Promise<unknown[]>) => ({
  from: () => ({ where: () => ({ limit: () => result }) }),
});

describe("supabaseGetScrapeById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the row when the replica has it", async () => {
    dbRrSelect.mockReturnValue(
      selectChain(Promise.resolve([{ id: "s1", team_id: "t1" }])),
    );

    await expect(supabaseGetScrapeById("s1")).resolves.toEqual({
      id: "s1",
      team_id: "t1",
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns null without logging when the row is absent", async () => {
    dbRrSelect.mockReturnValue(selectChain(Promise.resolve([])));

    await expect(supabaseGetScrapeById("s1")).resolves.toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs the error when the query throws, and still returns null", async () => {
    const error = new Error("connection reset");
    dbRrSelect.mockReturnValue(selectChain(Promise.reject(error)));

    await expect(supabaseGetScrapeById("s1")).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      "Scrape lookup error on replica",
      expect.objectContaining({
        scrapeId: "s1",
        source: "replica",
        durationMs: expect.any(Number),
        error,
      }),
    );
  });
});
