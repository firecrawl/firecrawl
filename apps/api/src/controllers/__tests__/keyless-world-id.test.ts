import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const { consume, client } = vi.hoisted(() => ({
  consume: vi.fn(),
  client: { ip: "203.0.113.8" },
}));

vi.mock("rate-limiter-flexible", async importOriginal => ({
  ...(await importOriginal<typeof import("rate-limiter-flexible")>()),
  RateLimiterRedis: class {
    keyPrefix: string;
    constructor(options: { keyPrefix: string }) {
      this.keyPrefix = options.keyPrefix;
    }
    consume(key: string) {
      return consume(this.keyPrefix, key);
    }
  },
}));
vi.mock("../../services/rate-limiter", () => ({ redisRateLimitClient: {} }));
vi.mock("../../db/connection", () => ({ db: {}, dbRr: {}, dbIndex: {} }));
vi.mock("../auth", () => ({ keylessClientIp: () => client.ip }));

import { RateLimiterRes } from "rate-limiter-flexible";
import { config } from "../../config";
import { sealDeviceCode } from "../../lib/world-id";
import {
  keylessWorldIdDeviceController,
  keylessWorldIdTokenController,
} from "../v2/keyless-world-id";

const original = {
  WORLD_ID_ISSUER: config.WORLD_ID_ISSUER,
  WORLD_ID_CLIENT_ID: config.WORLD_ID_CLIENT_ID,
  WORLD_ID_CLIENT_SECRET: config.WORLD_ID_CLIENT_SECRET,
  WORLD_ID_CREDENTIAL_SECRET: config.WORLD_ID_CREDENTIAL_SECRET,
  WORLD_ID_SUBJECT_SECRET: config.WORLD_ID_SUBJECT_SECRET,
};

function configure() {
  config.WORLD_ID_ISSUER = "https://auth.world.org";
  config.WORLD_ID_CLIENT_ID = "app_test";
  config.WORLD_ID_CLIENT_SECRET = "client-secret";
  config.WORLD_ID_CREDENTIAL_SECRET = "c".repeat(32);
  config.WORLD_ID_SUBJECT_SECRET = "s".repeat(32);
}

async function call(
  controller: typeof keylessWorldIdDeviceController,
  body: Record<string, unknown> = {},
) {
  const res = {
    status: vi.fn(),
    setHeader: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.setHeader.mockReturnValue(res);
  res.json.mockReturnValue(res);
  await controller(
    { body, headers: {} } as unknown as Request,
    res as unknown as Response,
  );
  return {
    status: res.status.mock.calls[0]?.[0],
    body: res.json.mock.calls[0]?.[0],
    headers: Object.fromEntries(res.setHeader.mock.calls),
  };
}

const poll = (controller = keylessWorldIdTokenController) =>
  call(controller, { device_handle: sealDeviceCode("device-code") });

describe("World ID keyless endpoints", () => {
  let fetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configure();
    client.ip = "203.0.113.8";
    consume.mockResolvedValue(undefined);
    fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
  });

  afterEach(() => {
    Object.assign(config, original);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("answers 404 without touching the issuer or the throttle while not configured", async () => {
    const handle = sealDeviceCode("device-code");
    config.WORLD_ID_CLIENT_ID = undefined;
    config.WORLD_ID_CLIENT_SECRET = undefined;
    config.WORLD_ID_CREDENTIAL_SECRET = undefined;
    config.WORLD_ID_SUBJECT_SECRET = undefined;

    for (const result of [
      await call(keylessWorldIdDeviceController),
      await call(keylessWorldIdTokenController, { device_handle: handle }),
    ]) {
      expect(result).toMatchObject({
        status: 404,
        body: { success: false, error: "Not found" },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("calls World's default issuer with a 10s timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetch.mockResolvedValue(
      Response.json({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://world.org/verify",
      }),
    );

    expect(await call(keylessWorldIdDeviceController)).toMatchObject({
      status: 200,
      body: { success: true, user_code: "ABCD-EFGH" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://auth.world.org/api/v1/device_authorization",
      expect.objectContaining({ signal: timeout.mock.results[0].value }),
    );
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it.each([
    ["unreachable", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "timing out",
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    ],
    [
      "erroring",
      () => Promise.resolve(new Response("unavailable", { status: 503 })),
    ],
  ])(
    "answers 502 without a credential while the issuer is %s",
    async (_, issuer) => {
      fetch.mockImplementation(issuer);
      const unavailable = {
        status: 502,
        body: { success: false, error: "temporarily_unavailable" },
      };

      expect(await call(keylessWorldIdDeviceController)).toMatchObject(
        unavailable,
      );
      expect(await poll()).toMatchObject(unavailable);
    },
  );

  it.each([
    [
      "an IPv4 caller in its own bucket",
      "::ffff:203.0.113.8",
      "",
      "203.0.113.8",
    ],
    [
      "a non-IPv4 caller in the shared bucket",
      "2001:db8::1",
      "_shared",
      "shared",
    ],
  ])("throttles %s", async (_, ip, suffix, key) => {
    client.ip = ip;
    fetch.mockRejectedValue(new TypeError("fetch failed"));

    await call(keylessWorldIdDeviceController);
    await poll();

    expect(consume.mock.calls).toEqual([
      [`keyless_world_id_start${suffix}`, key],
      [`keyless_world_id_poll${suffix}`, key],
    ]);
  });

  it("answers 429 before calling the issuer once a caller is out of starts or polls", async () => {
    consume.mockRejectedValue(new RateLimiterRes(0, 5_000));
    const throttled = {
      status: 429,
      body: { success: false, error: "slow_down" },
      headers: { "Retry-After": 5 },
    };

    expect(await call(keylessWorldIdDeviceController)).toEqual(throttled);
    expect(await poll()).toEqual(throttled);
    expect(fetch).not.toHaveBeenCalled();
  });
});
