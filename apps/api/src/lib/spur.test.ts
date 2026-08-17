import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: { get: vi.fn(), set: vi.fn() },
}));

import { config } from "../config";
import { logger } from "./logger";
import { isKeylessIpSuspicious } from "./spur";
import { redisRateLimitClient } from "../services/rate-limiter";

const IP = "203.0.113.42";

// Spur is looked up inline on the keyless auth path. These tests pin the failure
// policy, which is the whole point of the integration: a lookup that produces no
// verdict must be distinguishable from Spur not being configured at all, and
// only the former may ever reject a request.
describe("Spur keyless IP reputation", () => {
  const originalKey = config.SPUR_API_KEY;
  const originalFailClosed = config.SPUR_RESEARCH_FAIL_CLOSED;

  beforeEach(() => {
    vi.mocked(redisRateLimitClient.get).mockResolvedValue(null);
    vi.mocked(redisRateLimitClient.set).mockResolvedValue("OK");
    // Quiet the expected warn/info lines; individual tests spy where they assert.
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "info").mockImplementation(() => logger);
    config.SPUR_API_KEY = "test-spur-token";
    config.SPUR_RESEARCH_FAIL_CLOSED = false;
  });

  afterEach(() => {
    config.SPUR_API_KEY = originalKey;
    config.SPUR_RESEARCH_FAIL_CLOSED = originalFailClosed;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const stubFetch = (impl: (init: RequestInit) => Promise<unknown>) =>
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(((_url: string, init: RequestInit) =>
        impl(init)) as unknown as typeof fetch);

  const okResponse = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  describe("verdicts", () => {
    it("allows a clean IP", async () => {
      stubFetch(async () =>
        okResponse({ ip: IP, infrastructure: "DATACENTER", risks: [] }),
      );

      await expect(isKeylessIpSuspicious(IP)).resolves.toBe(false);
    });

    it("rejects an IP Spur classifies as a residential/rotating proxy", async () => {
      // client.proxies is how Spur reports residential proxy networks exiting an
      // IP — the vector behind distributed corpus harvesting.
      stubFetch(async () =>
        okResponse({ ip: IP, client: { proxies: ["IPROYAL"] } }),
      );

      await expect(isKeylessIpSuspicious(IP)).resolves.toBe(true);
    });

    it("rejects a proxy-classified IP even with fail-closed opted in", async () => {
      config.SPUR_RESEARCH_FAIL_CLOSED = true;
      stubFetch(async () => okResponse({ ip: IP, tunnels: [{ type: "VPN" }] }));

      await expect(
        isKeylessIpSuspicious(IP, { failClosed: true }),
      ).resolves.toBe(true);
    });
  });

  describe("failed lookups", () => {
    // Non-2xx covers the cases a burst of fresh IPs actually produces: 401 on a
    // bad token, 429 when Spur's own rate limit trips.
    const statusFailure = () =>
      stubFetch(
        async () =>
          ({
            ok: false,
            status: 429,
            json: async () => ({}),
          }) as unknown as Response,
      );

    it("fails open when the flag is off (today's behaviour)", async () => {
      statusFailure();

      await expect(
        isKeylessIpSuspicious(IP, { failClosed: true }),
      ).resolves.toBe(false);
    });

    it("fails closed when the flag is on and the call site opts in", async () => {
      config.SPUR_RESEARCH_FAIL_CLOSED = true;
      statusFailure();

      await expect(
        isKeylessIpSuspicious(IP, { failClosed: true }),
      ).resolves.toBe(true);
    });

    it("still fails open on call sites that have not opted in", async () => {
      // The flag alone must not shed keyless traffic outside the Research routes.
      config.SPUR_RESEARCH_FAIL_CLOSED = true;
      statusFailure();

      await expect(isKeylessIpSuspicious(IP)).resolves.toBe(false);
    });

    it("fails closed on a transport error too", async () => {
      config.SPUR_RESEARCH_FAIL_CLOSED = true;
      stubFetch(async () => {
        throw new TypeError("fetch failed");
      });

      await expect(
        isKeylessIpSuspicious(IP, { failClosed: true }),
      ).resolves.toBe(true);
    });

    it("does not cache a failed lookup", async () => {
      statusFailure();

      await isKeylessIpSuspicious(IP);

      expect(redisRateLimitClient.set).not.toHaveBeenCalled();
    });

    it("logs the failure kind and the policy it applied", async () => {
      config.SPUR_RESEARCH_FAIL_CLOSED = true;
      statusFailure();

      await isKeylessIpSuspicious(IP, { failClosed: true });

      expect(logger.warn).toHaveBeenCalledWith(
        "Spur lookup produced no verdict",
        expect.objectContaining({
          ip: IP,
          failure: "status",
          reason: "lookup_failed",
          failClosed: true,
        }),
      );
    });
  });

  describe("unconfigured Spur", () => {
    it("allows every IP when SPUR_API_KEY is unset, even with the flag on", async () => {
      // Self-hosted / unconfigured deployments must never be bricked by the flag.
      config.SPUR_API_KEY = undefined;
      config.SPUR_RESEARCH_FAIL_CLOSED = true;
      const fetchSpy = stubFetch(async () => okResponse({}));

      await expect(
        isKeylessIpSuspicious(IP, { failClosed: true }),
      ).resolves.toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("treats an empty SPUR_API_KEY as unset", async () => {
      config.SPUR_API_KEY = "";
      config.SPUR_RESEARCH_FAIL_CLOSED = true;

      await expect(
        isKeylessIpSuspicious(IP, { failClosed: true }),
      ).resolves.toBe(false);
    });
  });

  describe("timeout", () => {
    it("passes an abort signal to the Spur fetch", async () => {
      const fetchSpy = stubFetch(async () => okResponse({ ip: IP }));

      await isKeylessIpSuspicious(IP);

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("abandons a hanging Spur lookup and fails closed when the flag is on", async () => {
      config.SPUR_RESEARCH_FAIL_CLOSED = true;
      // Never resolves on its own: only the timeout signal can end this call.
      // Without a timeout wired into the fetch, this test hangs and fails.
      stubFetch(
        init =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () =>
              reject((init.signal as AbortSignal & { reason: unknown }).reason),
            );
          }),
      );

      await expect(
        isKeylessIpSuspicious(IP, { failClosed: true }),
      ).resolves.toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        "Spur Context API request errored",
        expect.objectContaining({ failure: "timeout" }),
      );
    });
  });
});
