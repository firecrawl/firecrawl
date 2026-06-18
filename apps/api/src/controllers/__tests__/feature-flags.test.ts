import { vi } from "vitest";
import { crawlController as crawlControllerV2 } from "../v2/crawl";
import { mapController as mapControllerV2 } from "../v2/map";

const originalCrawlEnv = process.env.DISABLE_CRAWL;
const originalMapEnv = process.env.DISABLE_MAP;

const resetEnv = (key: "DISABLE_CRAWL" | "DISABLE_MAP", value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

const mockResponse = () => {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const baseAuth = { team_id: "team" };

describe("feature disable flags", () => {
  afterEach(() => {
    resetEnv("DISABLE_CRAWL", originalCrawlEnv);
    resetEnv("DISABLE_MAP", originalMapEnv);
  });

  it("returns 403 for crawl when DISABLE_CRAWL is true", async () => {
    process.env.DISABLE_CRAWL = "true";
    const req: any = {
      body: { url: "https://example.com" },
      auth: baseAuth,
      acuc: undefined,
      account: { remainingCredits: 1 },
    };
    const res = mockResponse();

    await crawlControllerV2(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it("returns 403 for map when DISABLE_MAP is true", async () => {
    process.env.DISABLE_MAP = "true";
    const req: any = {
      body: { url: "https://example.com" },
      auth: baseAuth,
      acuc: undefined,
      account: { remainingCredits: 1 },
    };
    const res = mockResponse();

    await mapControllerV2(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });
});
