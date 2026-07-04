import { chQuery } from "../clickhouse-client";
import {
  InvalidThreatLogsCursorError,
  decodeThreatLogsCursor,
  queryThreatProtectionLogs,
} from "./logs";

vi.mock("../clickhouse-client", () => ({
  chQuery: vi.fn(),
}));

const ORG_ID = "0198a751-0000-7000-8000-00000000000f";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "11111111-2222-4333-8444-555555555555",
    event_time: "2026-07-04 12:00:00.000",
    team_id: "0198a751-0000-7000-8000-000000000001",
    request_id: "",
    job_id: "job-1",
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
    provider_consulted: 1,
    from_cache: 0,
    origin: "api",
    zero_data_retention: 0,
    ...overrides,
  };
}

describe("queryThreatProtectionLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes to the org, orders newest-first, and maps rows", async () => {
    vi.mocked(chQuery).mockResolvedValue([makeRow()]);

    const page = await queryThreatProtectionLogs({
      orgId: ORG_ID,
      limit: 50,
    });

    const [sql, params] = vi.mocked(chQuery).mock.calls[0];
    expect(sql).toContain("org_id = {orgId:String}");
    expect(sql).toContain("ORDER BY event_time DESC, event_id DESC");
    expect(params).toEqual(
      expect.objectContaining({ orgId: ORG_ID, limit: 51 }),
    );

    expect(page).toEqual({
      logs: [
        expect.objectContaining({
          id: "11111111-2222-4333-8444-555555555555",
          timestamp: "2026-07-04T12:00:00.000Z",
          domain: "blocked.example.com",
          url: "https://blocked.example.com/",
          decision: "blocked",
          rule: "risk-score",
          riskScore: 100,
          categories: ["MALWARE"],
          providerConsulted: true,
          fromCache: false,
          zeroDataRetention: false,
        }),
      ],
      nextCursor: null,
    });
  });

  it("applies from/to/decision/domain filters", async () => {
    vi.mocked(chQuery).mockResolvedValue([]);

    await queryThreatProtectionLogs({
      orgId: ORG_ID,
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-04T00:00:00.000Z"),
      decision: "blocked",
      domain: "HTTPS://Blocked.Example.com/path",
      limit: 10,
    });

    const [sql, params] = vi.mocked(chQuery).mock.calls[0];
    expect(sql).toContain("event_time >= {from:DateTime64(3)}");
    expect(sql).toContain("event_time <= {to:DateTime64(3)}");
    expect(sql).toContain("decision = {decision:String}");
    expect(sql).toContain("url_domain = {domain:String}");
    // Domain filter is normalized the same way stored domains are.
    expect(params).toEqual(
      expect.objectContaining({
        decision: "blocked",
        domain: "blocked.example.com",
      }),
    );
  });

  it("paginates with an opaque (event_time, event_id) cursor", async () => {
    const rows = [
      makeRow({ event_id: "11111111-2222-4333-8444-000000000001" }),
      makeRow({
        event_id: "11111111-2222-4333-8444-000000000002",
        event_time: "2026-07-04 11:59:59.000",
      }),
      makeRow({ event_id: "11111111-2222-4333-8444-000000000003" }),
    ];
    vi.mocked(chQuery).mockResolvedValue(rows);

    const page = await queryThreatProtectionLogs({ orgId: ORG_ID, limit: 2 });
    expect(page?.logs).toHaveLength(2);
    expect(page?.nextCursor).toEqual(expect.any(String));

    const decoded = decodeThreatLogsCursor(page!.nextCursor!);
    expect(decoded).toEqual({
      t: "2026-07-04 11:59:59.000",
      id: "11111111-2222-4333-8444-000000000002",
    });

    vi.mocked(chQuery).mockResolvedValue([rows[2]]);
    await queryThreatProtectionLogs({
      orgId: ORG_ID,
      limit: 2,
      cursor: page!.nextCursor!,
    });
    const [sql, params] = vi.mocked(chQuery).mock.calls[1];
    expect(sql).toContain(
      "(event_time, event_id) < ({cursorTime:DateTime64(3)}, {cursorId:UUID})",
    );
    expect(params).toEqual(
      expect.objectContaining({
        cursorTime: "2026-07-04 11:59:59.000",
        cursorId: "11111111-2222-4333-8444-000000000002",
      }),
    );
  });

  it("rejects malformed cursors", async () => {
    await expect(
      queryThreatProtectionLogs({
        orgId: ORG_ID,
        limit: 10,
        cursor: "not-a-cursor",
      }),
    ).rejects.toBeInstanceOf(InvalidThreatLogsCursorError);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it("returns null when ClickHouse is not configured", async () => {
    vi.mocked(chQuery).mockResolvedValue(null);
    const page = await queryThreatProtectionLogs({ orgId: ORG_ID, limit: 10 });
    expect(page).toBeNull();
  });
});
