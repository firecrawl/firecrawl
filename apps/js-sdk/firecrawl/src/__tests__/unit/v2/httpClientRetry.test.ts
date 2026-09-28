import { describe, expect, jest, test } from "@jest/globals";
import { HttpClient } from "../../../v2/utils/httpClient";

function makeClient() {
  const client = new HttpClient({
    apiKey: "test-key",
    apiUrl: "https://api.firecrawl.dev",
    maxRetries: 3,
    backoffFactor: 0,
  });
  const request = jest.fn<any>();
  (client as any).instance.request = request;
  return { client, request };
}

const badGateway = { isAxiosError: true, response: { status: 502 } };

describe("v2 HTTP retries", () => {
  test("retries a GET after a transient 502", async () => {
    const { client, request } = makeClient();
    request
      .mockRejectedValueOnce(badGateway)
      .mockResolvedValueOnce({ status: 200, data: { success: true } });

    await expect(client.get("/v2/crawl/job-id")).resolves.toMatchObject({
      status: 200,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test.each(["post", "patch", "delete"])(
    "does not replay a %s after a 502 whose upstream outcome is unknown",
    async (method) => {
      const { client, request } = makeClient();
      request.mockRejectedValue(badGateway);

      if (method === "post") {
        await expect(
          client.post("/v2/crawl", { url: "https://example.com" }),
        ).rejects.toBe(badGateway);
      } else if (method === "patch") {
        await expect(
          client.patch("/v2/monitor/id", { status: "paused" }),
        ).rejects.toBe(badGateway);
      } else {
        await expect(client.delete("/v2/browser/id")).rejects.toBe(badGateway);
      }
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  test("does not replay a POST with an idempotency key", async () => {
    const { client, request } = makeClient();
    request.mockRejectedValue(badGateway);

    await expect(
      client.post(
        "/v2/batch/scrape",
        { urls: ["https://example.com"] },
        {
          headers: client.prepareHeaders(
            "00000000-0000-4000-8000-000000000000",
          ),
        },
      ),
    ).rejects.toBe(badGateway);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("retries a POST only when its caller explicitly opts in", async () => {
    const { client, request } = makeClient();
    request
      .mockRejectedValueOnce(badGateway)
      .mockResolvedValueOnce({ status: 200, data: { success: true } });

    await expect(
      client.post(
        "/test/replay-protected",
        { value: 1 },
        {
          retryOnBadGateway: true,
        },
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("forwards an explicit retry opt-in for PATCH", async () => {
    const { client, request } = makeClient();
    request
      .mockRejectedValueOnce(badGateway)
      .mockResolvedValueOnce({ status: 200, data: { success: true } });

    await expect(
      client.patch(
        "/test/replay-protected",
        { status: "paused" },
        {
          retryOnBadGateway: true,
        },
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("forwards an explicit retry opt-in for multipart POST", async () => {
    const { client, request } = makeClient();
    request
      .mockRejectedValueOnce(badGateway)
      .mockResolvedValueOnce({ status: 200, data: { success: true } });

    await expect(
      client.postMultipart("/test/replay-protected", new FormData(), {
        retryOnBadGateway: true,
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
