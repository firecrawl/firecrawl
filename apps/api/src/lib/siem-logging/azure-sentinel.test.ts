import { gunzipSync } from "zlib";
import { Response } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AzureSentinelDestination, ScrapeActivityEvent } from "./types";
import {
  buildCompressedBatches,
  clearAzureTokenCache,
  sendAzureSentinelEvents,
  type SenderDependencies,
} from "./azure-sentinel";

const destination: AzureSentinelDestination = {
  type: "azure_sentinel",
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "secret",
  dceUrl: "https://example.eastus.ingest.monitor.azure.com",
  dcrImmutableId: "dcr-immutable",
  streamName: "Custom-FirecrawlScrapeActivity",
};

function event(id = "scrape-id"): ScrapeActivityEvent {
  return {
    schema_version: 1,
    event_type: "scrape_activity",
    scrape_id: id,
    request_id: "request-id",
    endpoint: "scrape",
    team_id: "team-id",
    org_id: "org-id",
    api_key: { id: "1", name: "default" },
    audit_metadata: { username: "alice@example.com" },
    started_at: "2026-07-24T00:00:00.000Z",
    completed_at: "2026-07-24T00:00:01.000Z",
    url: "https://example.com",
    domain: "example.com",
    http_method: "GET",
    http_status: 200,
    result: "success",
    error: null,
    origin: "api",
    integration: null,
    zero_data_retention: true,
  };
}

afterEach(() => clearAzureTokenCache());

describe("Azure Sentinel sender", () => {
  it("uses client credentials and sends a gzip JSON array", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl: SenderDependencies["fetchImpl"] = async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/token")) {
        return new Response(
          JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    };

    await sendAzureSentinelEvents(destination, [event()], {
      fetchImpl,
      tokenUrl: "https://login.example.test/token",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].init.body).toContain("client_secret=secret");
    expect(calls[0].init.body).toContain(
      "scope=https%3A%2F%2Fmonitor.azure.com%2F%2F.default",
    );
    expect(calls[1].url).toContain(
      "/dataCollectionRules/dcr-immutable/streams/Custom-FirecrawlScrapeActivity?api-version=2023-01-01",
    );
    expect(calls[1].init.headers["content-encoding"]).toBe("gzip");
    expect(calls[1].init.headers.authorization).toBe("Bearer access-token");
    expect(JSON.parse(gunzipSync(calls[1].init.body).toString("utf8"))).toEqual(
      [event()],
    );
  });

  it("distinguishes invalid credentials from a DCR schema rejection", async () => {
    const invalidCredentials: SenderDependencies["fetchImpl"] = async () =>
      new Response("invalid_client", { status: 400 });
    await expect(
      sendAzureSentinelEvents(destination, [event()], {
        fetchImpl: invalidCredentials,
        tokenUrl: "https://login.example.test/token",
      }),
    ).rejects.toMatchObject({
      kind: "invalid_credentials",
      statusCode: 400,
    });

    clearAzureTokenCache();
    const schemaRejection: SenderDependencies["fetchImpl"] = async url =>
      url.includes("/token")
        ? new Response(
            JSON.stringify({ access_token: "token", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response("InvalidOutputTable", { status: 400 });
    await expect(
      sendAzureSentinelEvents(destination, [event()], {
        fetchImpl: schemaRejection,
        tokenUrl: "https://login.example.test/token",
      }),
    ).rejects.toMatchObject({
      kind: "schema_rejection",
      statusCode: 400,
    });
  });

  it("respects Retry-After and makes three total attempts on 429", async () => {
    let ingestionAttempts = 0;
    const sleep = vi.fn(async () => {});
    const fetchImpl: SenderDependencies["fetchImpl"] = async url => {
      if (url.includes("/token")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      ingestionAttempts++;
      return ingestionAttempts < 3
        ? new Response("slow down", {
            status: 429,
            headers: { "retry-after": "2" },
          })
        : new Response(null, { status: 204 });
    };

    await sendAzureSentinelEvents(destination, [event()], {
      fetchImpl,
      sleep,
      tokenUrl: "https://login.example.test/token",
    });

    expect(ingestionAttempts).toBe(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it("caps Retry-After and releases retry response bodies", async () => {
    const sleep = vi.fn(async () => {});
    const retryResponses: Response[] = [];
    let ingestionAttempts = 0;
    const fetchImpl: SenderDependencies["fetchImpl"] = async url => {
      if (url.includes("/token")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      ingestionAttempts++;
      if (ingestionAttempts < 3) {
        const response = new Response("try later", {
          status: 503,
          headers: { "retry-after": "86400" },
        });
        retryResponses.push(response);
        return response;
      }
      return new Response(null, { status: 204 });
    };

    await sendAzureSentinelEvents(destination, [event()], {
      fetchImpl,
      sleep,
      tokenUrl: "https://login.example.test/token",
    });

    expect(sleep).toHaveBeenNthCalledWith(1, 30_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 30_000);
    expect(retryResponses.every(response => response.bodyUsed)).toBe(true);
  });

  it("exposes the capped Retry-After delay after the final attempt", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl: SenderDependencies["fetchImpl"] = async url => {
      if (url.includes("/token")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response("try later", {
        status: 429,
        headers: { "retry-after": "86400" },
      });
    };

    await expect(
      sendAzureSentinelEvents(destination, [event()], {
        fetchImpl,
        sleep,
        tokenUrl: "https://login.example.test/token",
      }),
    ).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 30_000,
    });
  });

  it("retries transient network failures three times", async () => {
    let ingestionAttempts = 0;
    const sleep = vi.fn(async () => {});
    const fetchImpl: SenderDependencies["fetchImpl"] = async url => {
      if (url.includes("/token")) {
        return new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      ingestionAttempts++;
      throw new Error("connection reset");
    };

    await expect(
      sendAzureSentinelEvents(destination, [event()], {
        fetchImpl,
        sleep,
        tokenUrl: "https://login.example.test/token",
      }),
    ).rejects.toMatchObject({ kind: "delivery_error" });

    expect(ingestionAttempts).toBe(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);
  });

  it("classifies ingestion authorization failures as invalid credentials", async () => {
    const fetchImpl: SenderDependencies["fetchImpl"] = async url =>
      url.includes("/token")
        ? new Response(
            JSON.stringify({ access_token: "token", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response("Forbidden", { status: 403 });

    await expect(
      sendAzureSentinelEvents(destination, [event()], {
        fetchImpl,
        tokenUrl: "https://login.example.test/token",
      }),
    ).rejects.toMatchObject({
      kind: "invalid_credentials",
      statusCode: 403,
    });
  });

  it("refreshes a rejected cached token once", async () => {
    let tokenRequests = 0;
    const ingestionTokens: string[] = [];
    const fetchImpl: SenderDependencies["fetchImpl"] = async (url, init) => {
      if (url.includes("/token")) {
        tokenRequests++;
        return new Response(
          JSON.stringify({
            access_token: `token-${tokenRequests}`,
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      ingestionTokens.push(init.headers.authorization);
      return init.headers.authorization === "Bearer token-1"
        ? new Response("revoked", { status: 401 })
        : new Response(null, { status: 204 });
    };

    await sendAzureSentinelEvents(destination, [event()], {
      fetchImpl,
      tokenUrl: "https://login.example.test/token",
    });

    expect(tokenRequests).toBe(2);
    expect(ingestionTokens).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("does not reuse a token after client-secret rotation", async () => {
    let tokenRequests = 0;
    const fetchImpl: SenderDependencies["fetchImpl"] = async url => {
      if (url.includes("/token")) {
        tokenRequests++;
        return new Response(
          JSON.stringify({
            access_token: `token-${tokenRequests}`,
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    };

    await sendAzureSentinelEvents(destination, [event("first")], {
      fetchImpl,
      tokenUrl: "https://login.example.test/token",
    });
    await sendAzureSentinelEvents(
      { ...destination, clientSecret: "rotated-secret" },
      [event("second")],
      { fetchImpl, tokenUrl: "https://login.example.test/token" },
    );

    expect(tokenRequests).toBe(2);
  });

  it("splits compressed payloads at the configured byte ceiling", () => {
    const noisyEvents = Array.from({ length: 8 }, (_, index) =>
      event(
        `${index}-${Array.from({ length: 30 }, () => crypto.randomUUID()).join("")}`,
      ),
    );
    const batches = buildCompressedBatches(noisyEvents, 1200);
    expect(Array.isArray(batches)).toBe(false);
    const compressedBodies = [...batches];

    expect(compressedBodies.length).toBeGreaterThan(1);
    expect(compressedBodies.every(batch => batch.body.byteLength <= 1200)).toBe(
      true,
    );
    expect(
      compressedBodies.flatMap(batch =>
        JSON.parse(gunzipSync(batch.body).toString("utf8")),
      ),
    ).toHaveLength(noisyEvents.length);
    // Each batch reports its own size so the caller can count what it delivered.
    expect(
      compressedBodies.reduce((total, batch) => total + batch.eventCount, 0),
    ).toBe(noisyEvents.length);
  });

  // An event too large to ever deliver must not take its batch down with it: the
  // sender POSTs chunk by chunk, so failing the call would both lose the good
  // events and duplicate any chunk already accepted when they were replayed.
  it("skips an undeliverable event and still delivers the rest of the batch", () => {
    const oversized = event(
      Array.from({ length: 400 }, () => crypto.randomUUID()).join(""),
    );
    const events = [event("small-1"), oversized, event("small-2")];

    const batches = [...buildCompressedBatches(events, 1200)];
    const delivered = batches.flatMap(batch =>
      JSON.parse(gunzipSync(batch.body).toString("utf8")),
    ) as ScrapeActivityEvent[];

    expect(delivered.map(e => e.scrape_id)).toEqual(["small-1", "small-2"]);
    // The skipped event must not be counted as delivered — it is already
    // counted as dropped, and double-counting it corrupts both metrics.
    expect(batches.reduce((total, batch) => total + batch.eventCount, 0)).toBe(
      2,
    );
  });
});
