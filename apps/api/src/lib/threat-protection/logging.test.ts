import { buildThreatCheckEvent, emitThreatCheck } from "./logging";
import { enqueueSiemThreatEvent } from "../../services/webhook/siem";
import { getOrgIdForTeam } from "./store";
import type { RawVerdict, ThreatDecision } from "./types";

vi.mock("../../services/webhook/siem", () => ({
  enqueueSiemThreatEvent: vi.fn(),
}));
vi.mock("./store", () => ({
  getOrgIdForTeam: vi.fn(),
}));

const RAW_PROVIDER_PAYLOAD = {
  secretProviderField: "must-never-be-stored",
};

const verdict: RawVerdict = {
  provider: "google-web-risk",
  riskScore: 91,
  categories: ["MALWARE", "SOCIAL_ENGINEERING"],
  fromCache: true,
  raw: RAW_PROVIDER_PAYLOAD,
};

const blockedDecision: ThreatDecision = {
  allowed: false,
  rule: "risk-score",
  providerConsulted: true,
  verdict,
  mode: "normal",
};

const localAllowDecision: ThreatDecision = {
  allowed: true,
  rule: "whitelist",
  providerConsulted: false,
  verdict: null,
  mode: "normal",
};

const TEAM_ID = "0198a751-0000-7000-8000-000000000001";
const ORG_ID = "0198a751-0000-7000-8000-00000000000f";

describe("buildThreatCheckEvent", () => {
  it("maps decision + verdict + ctx onto the row shape", () => {
    const event = buildThreatCheckEvent(
      "risky.example.com",
      blockedDecision,
      {
        teamId: TEAM_ID,
        requestId: "req-1",
        jobId: "job-1",
        crawlId: "crawl-1",
        endpoint: "scrape",
        url: "https://risky.example.com/page",
        origin: "api",
        zeroDataRetention: false,
      },
      ORG_ID,
    );

    expect(event).toEqual(
      expect.objectContaining({
        team_id: TEAM_ID,
        org_id: ORG_ID,
        request_id: "req-1",
        job_id: "job-1",
        crawl_id: "crawl-1",
        endpoint: "scrape",
        url: "https://risky.example.com/page",
        url_domain: "risky.example.com",
        mode: "normal",
        provider: "google-web-risk",
        risk_score: 91,
        categories: ["MALWARE", "SOCIAL_ENGINEERING"],
        decision: "blocked",
        rule: "risk-score",
        provider_consulted: true,
        from_cache: true,
        origin: "api",
        zero_data_retention: false,
      }),
    );
    expect(event.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(event.event_time)).not.toBeNaN();
  });

  it("never includes the raw provider payload", () => {
    const event = buildThreatCheckEvent("risky.example.com", blockedDecision, {
      teamId: TEAM_ID,
      url: "https://risky.example.com/page",
    });
    expect(JSON.stringify(event)).not.toContain("must-never-be-stored");
    expect("raw" in event).toBe(false);
  });

  it("zero-data-retention: keeps the domain but drops the URL", () => {
    const event = buildThreatCheckEvent("risky.example.com", blockedDecision, {
      teamId: TEAM_ID,
      url: "https://risky.example.com/secret-path?q=1",
      zeroDataRetention: true,
    });
    expect(event.url).toBe("");
    expect(event.url_domain).toBe("risky.example.com");
    expect(event.zero_data_retention).toBe(true);
    expect(JSON.stringify(event)).not.toContain("secret-path");
  });

  it("local-only allowed decision has empty verdict fields", () => {
    const event = buildThreatCheckEvent(
      "clean.example.com",
      localAllowDecision,
      { teamId: TEAM_ID },
    );
    expect(event).toEqual(
      expect.objectContaining({
        decision: "allowed",
        rule: "whitelist",
        provider: "",
        risk_score: null,
        categories: [],
        provider_consulted: false,
        from_cache: false,
        url: "",
      }),
    );
  });
});

describe("emitThreatCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers to the SIEM buffer with the resolved org id", async () => {
    vi.mocked(getOrgIdForTeam).mockResolvedValue(ORG_ID);
    const teamId = "0198a751-0000-7000-8000-000000000002";

    emitThreatCheck("risky.example.com", blockedDecision, { teamId });

    await vi.waitFor(() => {
      expect(enqueueSiemThreatEvent).toHaveBeenCalledTimes(1);
    });
    expect(getOrgIdForTeam).toHaveBeenCalledWith(teamId);

    const [siemOrgId, siemEvent] = vi.mocked(enqueueSiemThreatEvent).mock
      .calls[0];
    expect(siemOrgId).toBe(ORG_ID);
    expect(siemEvent.org_id).toBe(ORG_ID);
  });

  it("zero-data-retention events drop the URL before leaving the process", async () => {
    emitThreatCheck("risky.example.com", blockedDecision, {
      teamId: TEAM_ID,
      orgId: ORG_ID,
      url: "https://risky.example.com/secret-path",
      zeroDataRetention: true,
    });

    await vi.waitFor(() => {
      expect(enqueueSiemThreatEvent).toHaveBeenCalledTimes(1);
    });
    const [, siemEvent] = vi.mocked(enqueueSiemThreatEvent).mock.calls[0];
    expect(siemEvent.zero_data_retention).toBe(true);
    expect(siemEvent.url).toBe("");
  });

  it("uses ctx.orgId without a team lookup", async () => {
    emitThreatCheck("risky.example.com", blockedDecision, {
      teamId: TEAM_ID,
      orgId: ORG_ID,
    });

    await vi.waitFor(() => {
      expect(enqueueSiemThreatEvent).toHaveBeenCalledTimes(1);
    });
    expect(getOrgIdForTeam).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueSiemThreatEvent).mock.calls[0][0]).toBe(ORG_ID);
  });

  it("drops the event when the org cannot be resolved (no SIEM destination)", async () => {
    // Pseudo teams ("sitemap", "robots-txt") are not UUIDs — no org lookup,
    // so there is no SIEM destination to deliver to. Nothing is persisted
    // anywhere by design.
    emitThreatCheck("risky.example.com", blockedDecision, {
      teamId: "sitemap",
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(getOrgIdForTeam).not.toHaveBeenCalled();
    expect(enqueueSiemThreatEvent).not.toHaveBeenCalled();
  });

  it('does not emit for mode "off" decisions', async () => {
    emitThreatCheck(
      "example.com",
      {
        allowed: true,
        rule: "default-allow",
        providerConsulted: false,
        verdict: null,
        mode: "off",
      },
      { teamId: TEAM_ID, orgId: ORG_ID },
    );

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(enqueueSiemThreatEvent).not.toHaveBeenCalled();
  });

  it("never throws when the SIEM sink fails", async () => {
    vi.mocked(enqueueSiemThreatEvent).mockImplementationOnce(() => {
      throw new Error("siem buffer down");
    });
    expect(() =>
      emitThreatCheck("risky.example.com", blockedDecision, {
        teamId: TEAM_ID,
        orgId: ORG_ID,
      }),
    ).not.toThrow();
    await vi.waitFor(() => {
      expect(enqueueSiemThreatEvent).toHaveBeenCalledTimes(1);
    });
  });
});
