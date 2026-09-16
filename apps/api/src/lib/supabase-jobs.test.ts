const { primarySelect, replicaSelect } = vi.hoisted(() => ({
  primarySelect: vi.fn(),
  replicaSelect: vi.fn(),
}));

vi.mock("../db/connection", () => ({
  db: { select: primarySelect },
  dbRr: { select: replicaSelect },
}));

import { supabaseGetScrapeByIdDirect } from "./supabase-jobs";

describe("supabaseGetScrapeByIdDirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
