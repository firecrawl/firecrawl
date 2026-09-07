import express from "express";
import {
  mountUnconfiguredResearchRoutes,
  researchServiceUnavailable,
} from "./research-unavailable";

describe("researchServiceUnavailable", () => {
  it("returns 501 JSON naming the missing research backend", () => {
    const res: any = {
      status: vi.fn(),
      json: vi.fn(),
    };
    res.status.mockReturnValue(res);

    researchServiceUnavailable({} as express.Request, res);

    expect(res.status).toHaveBeenCalledWith(501);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Research service is not configured",
    });
  });
});

describe("mountUnconfiguredResearchRoutes", () => {
  it("registers the canonical and legacy research prefixes", () => {
    const router = express.Router();
    mountUnconfiguredResearchRoutes(router);
    expect(router.stack).toHaveLength(2);
  });
});
