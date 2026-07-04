import { createHmac, randomUUID } from "crypto";
import undici from "undici";
import { config } from "../../config";
import { enqueueSiemThreatEvent, sendSiemTestEvent } from "./siem";
import { getOrgThreatProtectionConfig } from "../../lib/threat-protection/store";
import type { OrgThreatProtectionConfig } from "../../lib/threat-protection/store";
import { logWebhook } from "./delivery";
import type { ThreatCheckEvent } from "../../lib/threat-protection/logging";

vi.mock("undici", () => ({
  default: { fetch: vi.fn() },
}));
vi.mock("../../scraper/scrapeURL/engines/utils/safeFetch", () => ({
  getSecureDispatcherNoCookies: () => undefined,
  isIPPrivate: () => false,
}));
vi.mock("../../lib/threat-protection/store", () => ({
  getOrgThreatProtectionConfig: vi.fn(),
}));
vi.mock("./delivery", () => ({
  logWebhook: vi.fn().mockResolvedValue(undefined),
}));

const TEAM_ID = "0198a751-0000-7000-8000-000000000001";
const SIEM_URL = "https://siem.example-receiver.com/ingest";
const SIEM_SECRET = "test-secret";

function makeEvent(overrides: Partial<ThreatCheckEvent>): ThreatCheckEvent {
  return {
    event_id: randomUUID(),
    event_time: new Date().toISOString(),
    team_id: TEAM_ID,
    org_id: "org",
    request_id: "",
    job_id: "",
    crawl_id: "",
    endpoint: "scrape",
    url: "https://blocked.example.com/",
    url_domain: "blocked.example.com",
    mode: "normal",
    provider: "google-web-risk",
    risk_score: 100,
    categories: ["MALWARE"],
    domain_age_days: null,
    country_code: "",
    decision: "blocked",
    rule: "risk-score",
    provider_consulted: true,
    from_cache: false,
    origin: "api",
    zero_data_retention: false,
    ...overrides,
  };
}

function mockSiemConfig(
  orgId: string,
  events: "blocked" | "all",
  secret: string | null = SIEM_SECRET,
): void {
  vi.mocked(getOrgThreatProtectionConfig).mockResolvedValue({
    orgId,
    siem: { url: SIEM_URL, secret, events },
  } as OrgThreatProtectionConfig);
}

function okResponse() {
  return { ok: true, status: 200 } as Awaited<ReturnType<typeof undici.fetch>>;
}

function sentPayloads(): { body: string; headers: Record<string, string> }[] {
  return vi.mocked(undici.fetch).mock.calls.map(call => ({
    body: (call[1] as { body: string }).body,
    headers: (call[1] as { headers: Record<string, string> }).headers,
  }));
}

describe("SIEM threat event push", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(undici.fetch).mockResolvedValue(okResponse());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a full batch immediately (no POST-per-check)", async () => {
    const orgId = randomUUID();
    mockSiemConfig(orgId, "all");

    for (let i = 0; i < config.THREAT_SIEM_BATCH_SIZE; i++) {
      enqueueSiemThreatEvent(orgId, makeEvent({ decision: "allowed" }));
    }

    await vi.waitFor(() => {
      expect(undici.fetch).toHaveBeenCalledTimes(1);
    });

    const payload = JSON.parse(sentPayloads()[0].body);
    expect(payload.type).toBe("threat_protection.check_batch");
    expect(payload.batchId).toEqual(expect.any(String));
    expect(payload.events).toHaveLength(config.THREAT_SIEM_BATCH_SIZE);
  });

  it("flushes a partial buffer after the flush interval", async () => {
    vi.useFakeTimers();
    const orgId = randomUUID();
    mockSiemConfig(orgId, "all");

    enqueueSiemThreatEvent(orgId, makeEvent({}));
    enqueueSiemThreatEvent(orgId, makeEvent({}));
    expect(undici.fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(config.THREAT_SIEM_FLUSH_INTERVAL_MS);

    expect(undici.fetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sentPayloads()[0].body);
    expect(payload.events).toHaveLength(2);
  });

  it('respects siem_events "blocked": allowed decisions are filtered out', async () => {
    vi.useFakeTimers();
    const orgId = randomUUID();
    mockSiemConfig(orgId, "blocked");

    enqueueSiemThreatEvent(
      orgId,
      makeEvent({ decision: "allowed", url_domain: "clean.example.com" }),
    );
    enqueueSiemThreatEvent(
      orgId,
      makeEvent({ decision: "blocked", url_domain: "bad.example.com" }),
    );
    await vi.advanceTimersByTimeAsync(config.THREAT_SIEM_FLUSH_INTERVAL_MS);

    expect(undici.fetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sentPayloads()[0].body);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].url_domain).toBe("bad.example.com");
  });

  it('sends nothing when siem_events is "blocked" and no event is blocked', async () => {
    vi.useFakeTimers();
    const orgId = randomUUID();
    mockSiemConfig(orgId, "blocked");

    enqueueSiemThreatEvent(orgId, makeEvent({ decision: "allowed" }));
    await vi.advanceTimersByTimeAsync(config.THREAT_SIEM_FLUSH_INTERVAL_MS);

    expect(undici.fetch).not.toHaveBeenCalled();
  });

  it("drops events when the org has no SIEM destination", async () => {
    vi.useFakeTimers();
    const orgId = randomUUID();
    vi.mocked(getOrgThreatProtectionConfig).mockResolvedValue(null);

    enqueueSiemThreatEvent(orgId, makeEvent({}));
    await vi.advanceTimersByTimeAsync(config.THREAT_SIEM_FLUSH_INTERVAL_MS);

    expect(undici.fetch).not.toHaveBeenCalled();
  });

  it("signs the payload with the org's siem_secret (HMAC-SHA256)", async () => {
    vi.useFakeTimers();
    const orgId = randomUUID();
    mockSiemConfig(orgId, "all");

    enqueueSiemThreatEvent(orgId, makeEvent({}));
    await vi.advanceTimersByTimeAsync(config.THREAT_SIEM_FLUSH_INTERVAL_MS);

    const { body, headers } = sentPayloads()[0];
    const expected = `sha256=${createHmac("sha256", SIEM_SECRET)
      .update(body)
      .digest("hex")}`;
    expect(headers["X-Firecrawl-Signature"]).toBe(expected);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("retries failed deliveries and records the outcome in webhook logs", async () => {
    vi.useFakeTimers();
    const orgId = randomUUID();
    mockSiemConfig(orgId, "all");
    vi.mocked(undici.fetch)
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(okResponse());

    enqueueSiemThreatEvent(orgId, makeEvent({}));
    await vi.advanceTimersByTimeAsync(config.THREAT_SIEM_FLUSH_INTERVAL_MS);
    // Retry backoff.
    await vi.advanceTimersByTimeAsync(10000);

    expect(undici.fetch).toHaveBeenCalledTimes(2);
    expect(logWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        teamId: TEAM_ID,
        url: SIEM_URL,
        event: "threat_protection.check_batch",
        statusCode: 200,
      }),
    );
  });

  it("logs a failure after exhausting retries", async () => {
    vi.useFakeTimers();
    const orgId = randomUUID();
    mockSiemConfig(orgId, "all");
    vi.mocked(undici.fetch).mockRejectedValue(new Error("connection reset"));

    enqueueSiemThreatEvent(orgId, makeEvent({}));
    await vi.advanceTimersByTimeAsync(config.THREAT_SIEM_FLUSH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(60000);

    expect(undici.fetch).toHaveBeenCalledTimes(3);
    expect(logWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "connection reset",
      }),
    );
  });
});

describe("sendSiemTestEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers one clearly-marked synthetic test event", async () => {
    vi.mocked(undici.fetch).mockResolvedValue(okResponse());

    const result = await sendSiemTestEvent(randomUUID(), TEAM_ID, {
      url: SIEM_URL,
      secret: SIEM_SECRET,
      events: "blocked",
    });

    expect(result).toEqual({ delivered: true, statusCode: 200 });
    const { body, headers } = sentPayloads()[0];
    const payload = JSON.parse(body);
    expect(payload.type).toBe("threat_protection.test");
    expect(payload.test).toBe(true);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].rule).toBe("siem-test");
    expect(payload.events[0].categories).toEqual(["TEST_EVENT"]);
    expect(headers["X-Firecrawl-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("reports delivery failure without throwing", async () => {
    vi.mocked(undici.fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as Awaited<ReturnType<typeof undici.fetch>>);

    const result = await sendSiemTestEvent(randomUUID(), TEAM_ID, {
      url: SIEM_URL,
      secret: null,
      events: "all",
    });

    expect(result.delivered).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toContain("500");
  });
});
