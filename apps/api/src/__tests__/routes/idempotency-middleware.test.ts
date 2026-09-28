import type { NextFunction, Request, Response } from "express";

vi.mock("../../services/idempotency/claim", () => ({
  claimIdempotencyKey: vi.fn(),
}));
import { claimIdempotencyKey } from "../../services/idempotency/claim";
import { idempotencyMiddleware } from "../../services/idempotency/middleware";

describe("idempotencyMiddleware", () => {
  const claim = vi.mocked(claimIdempotencyKey);

  beforeEach(() => {
    claim.mockReset();
  });

  it("does not start the controller before the key is stored", async () => {
    let finishClaim!: (claimed: boolean) => void;
    claim.mockReturnValue(
      new Promise(resolve => {
        finishClaim = resolve;
      }),
    );
    const req = {
      headers: { "x-idempotency-key": "test-key" },
    } as unknown as Request;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    idempotencyMiddleware(req, res, next);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();

    finishClaim(true);
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  });

  it("rejects a second request when its claim loses", async () => {
    claim.mockResolvedValue(false);
    const req = {
      headers: { "x-idempotency-key": "test-key" },
    } as unknown as Request;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    idempotencyMiddleware(req, res, next);
    await vi.waitFor(() => expect(res.status).toHaveBeenCalledWith(409));
    expect(next).not.toHaveBeenCalled();
  });

  it("passes a storage failure to Express without starting the controller", async () => {
    const failure = new Error("database unavailable");
    claim.mockRejectedValue(failure);
    const req = {
      headers: { "x-idempotency-key": "test-key" },
    } as unknown as Request;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    idempotencyMiddleware(req, res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(failure));
    expect(res.status).not.toHaveBeenCalled();
  });
});
