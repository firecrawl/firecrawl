import type { NextFunction, Request, Response } from "express";

vi.mock("../../services/idempotency/claim", () => ({
  claimIdempotencyKey: vi.fn(),
  InvalidIdempotencyKeyError: class extends Error {},
}));
import {
  claimIdempotencyKey,
  InvalidIdempotencyKeyError,
} from "../../services/idempotency/claim";
import { idempotencyMiddleware } from "../../services/idempotency/middleware";

describe("idempotencyMiddleware", () => {
  const claim = vi.mocked(claimIdempotencyKey);

  beforeEach(() => {
    claim.mockReset();
  });

  it("continues without claiming when no key is supplied", async () => {
    const req = { headers: {} } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    idempotencyMiddleware(req, res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(claim).not.toHaveBeenCalled();
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

  it("does not write a duplicate response after headers have been sent", async () => {
    claim.mockResolvedValue(false);
    const req = {
      headers: { "x-idempotency-key": "test-key" },
    } as unknown as Request;
    const res = {
      headersSent: true,
      status: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    idempotencyMiddleware(req, res, next);
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("reports a malformed key as 400 rather than a duplicate", async () => {
    claim.mockRejectedValue(new InvalidIdempotencyKeyError("invalid key"));
    const req = {
      headers: { "x-idempotency-key": "invalid" },
    } as unknown as Request;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    idempotencyMiddleware(req, res, next);
    await vi.waitFor(() => expect(res.status).toHaveBeenCalledWith(400));
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
