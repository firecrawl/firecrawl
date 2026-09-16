const { primarySelect, replicaSelect } = vi.hoisted(() => ({
  primarySelect: vi.fn(),
  replicaSelect: vi.fn(),
}));

vi.mock("../db/connection", () => ({
  db: { select: primarySelect },
  dbRr: { select: replicaSelect },
}));

import { supabaseGetScrapeByIdDirect } from "./supabase-jobs";
import { logger } from "./logger";

describe("supabaseGetScrapeByIdDirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads newly-created scrapes from the primary database", async () => {
    const scrape = { id: "scrape-123" };
    const query = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([scrape]),
    };
    query.from.mockReturnValue(query);
    query.where.mockReturnValue(query);
    primarySelect.mockReturnValue(query);

    await expect(supabaseGetScrapeByIdDirect(scrape.id)).resolves.toBe(scrape);

    expect(primarySelect).toHaveBeenCalledOnce();
    expect(replicaSelect).not.toHaveBeenCalled();
  });

  it("surfaces primary database errors instead of returning a false miss", async () => {
    const error = new Error("primary unavailable");
    const query = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockRejectedValue(error),
    };
    query.from.mockReturnValue(query);
    query.where.mockReturnValue(query);
    primarySelect.mockReturnValue(query);
    const logError = vi.spyOn(logger, "error").mockImplementation(() => logger);

    await expect(supabaseGetScrapeByIdDirect("scrape-123")).rejects.toBe(error);

    expect(logError).toHaveBeenCalledWith(
      "Error in supabaseGetScrapeByIdDirect",
      {
        error,
        scrapeId: "scrape-123",
      },
    );
    expect(replicaSelect).not.toHaveBeenCalled();
  });
});
