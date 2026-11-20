import type { MockedFunction } from "vitest";
import type { NextFunction } from "express";

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: { checkCredits: vi.fn() },
  CREDITS_FEATURE_ID: "CREDITS",
}));

vi.mock("../../services/autumn/usage", () => ({
  getTeamBalance: vi.fn(),
}));

vi.mock("../../lib/http-metrics", () => ({
  httpRequestDurationSeconds: { observe: vi.fn() },
  getRoutePattern: vi.fn(() => "/v1/crawl"),
}));

vi.mock("../../controllers/auth", () => ({
  authenticateUser: vi.fn(),
}));

vi.mock("../../services/idempotency/create", () => ({
  createIdempotencyKey: vi.fn(),
}));

vi.mock("../../services/idempotency/validate", () => ({
  validateIdempotencyKey: vi.fn(),
}));

vi.mock("geoip-country", () => ({ lookup: vi.fn(() => null) }));

import { idempotencyMiddleware } from "../../routes/shared";
import { createIdempotencyKey } from "../../services/idempotency/create";
import { validateIdempotencyKey } from "../../services/idempotency/validate";

const createMock = createIdempotencyKey as MockedFunction<
  typeof createIdempotencyKey
>;
const validateMock = validateIdempotencyKey as MockedFunction<
  typeof validateIdempotencyKey
>;

const KEY = "11111111-1111-4111-8111-111111111111";

function run(req: any): Promise<{ res: any; nextErr?: unknown; nextCalled: boolean }> {
  return new Promise(resolve => {
    const res: any = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(function (this: any) {
        setImmediate(() => resolve({ res, nextCalled: false }));
        return this;
      }),
    };
    const next: NextFunction = (err?: unknown) =>
      resolve({ res, nextErr: err, nextCalled: true });
    idempotencyMiddleware(req, res, next);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("idempotencyMiddleware", () => {
  it("continues once the key is recorded", async () => {
    validateMock.mockResolvedValue(true);
    createMock.mockResolvedValue(KEY);

    const { nextCalled, nextErr } = await run({
      headers: { "x-idempotency-key": KEY },
    });

    expect(nextCalled).toBe(true);
    expect(nextErr).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("hands a rejected key insert to the error handler", async () => {
    validateMock.mockResolvedValue(true);
    const rejection = new Error("insert rejected");
    createMock.mockRejectedValue(rejection);

    const { nextCalled, nextErr } = await run({
      headers: { "x-idempotency-key": KEY },
    });

    expect(nextCalled).toBe(true);
    expect(nextErr).toBe(rejection);
  });

  it("answers 409 for a key already used", async () => {
    validateMock.mockResolvedValue(false);

    const { res, nextCalled } = await run({
      headers: { "x-idempotency-key": KEY },
    });

    expect(nextCalled).toBe(false);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(createMock).not.toHaveBeenCalled();
  });
});
