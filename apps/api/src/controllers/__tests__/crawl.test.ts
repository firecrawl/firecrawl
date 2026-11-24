import { crawlController } from "../v0/crawl";
import { config } from "../../config";
import { Request, Response } from "express";
import { v7 as uuidv7 } from "uuid";
import { defaultModules, type CoreParts } from "../../service";
import { testService, withService } from "../../service/testing";

vi.mock("../auth", () => ({
  authenticateUser: vi.fn().mockResolvedValue({
    success: true,
    team_id: "team123",
    error: null,
    status: 200,
  }),
  reduce: vi.fn(),
}));

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

describe("crawlController", () => {
  it("should prevent duplicate requests using the same idempotency key", async () => {
    const req = {
      headers: {
        "x-idempotency-key": uuidv7(),
        Authorization: `Bearer ${config.TEST_API_KEY}`,
      },
      body: {
        url: "https://mendable.ai",
      },
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    const claim = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await withService(
      testService(defaultModules(), parts, { idempotency: { claim } }),
      async () => {
        // First request should succeed
        await crawlController(req, res);
        expect(res.status).not.toHaveBeenCalledWith(409);

        // Second request with the same key should fail
        await crawlController(req, res);
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith({
          error: "Idempotency key already used",
        });
      },
    );
  });
});
