import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { logger };
});
vi.mock("../../../services/logging/log_job", () => ({
  logRequest: vi.fn(async () => {}),
  logMap: vi.fn(async () => {}),
}));
vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn(async () => {}),
}));
vi.mock("../../../lib/external-request-id", () => ({
  externalRequestId: () => undefined,
}));
vi.mock("../../../lib/threat-protection/request", () => ({
  resolveThreatProtection: vi.fn(async () => ({})),
  checkUrlsAgainstThreatPolicy: vi.fn(),
}));
vi.mock("../../../lib/scrape-billing", () => ({
  calculateThreatScanCredits: vi.fn(),
}));
vi.mock("../../../lib/map-utils", () => ({
  getMapResults: vi.fn(async () => ({
    job_id: "map-1",
    mapResults: [
      { url: "https://example.com/" },
      { url: "https://example.com/about" },
    ],
  })),
}));
vi.mock("../../../lib/avgrab-resolve", () => ({
  AvgrabResolveError: class extends Error {},
  resolveViaAvgrab: vi.fn(async () => null),
}));

import { mapController } from "../map";
import { getMapResults } from "../../../lib/map-utils";
import { resolveViaAvgrab } from "../../../lib/avgrab-resolve";

const request = (flags: Record<string, unknown> | null) =>
  ({
    body: { url: "https://example.com" },
    headers: {},
    auth: { team_id: "team-a" },
    acuc: { flags, org_id: null, api_key_id: null },
  }) as any;

const response = () => {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("v2 map and the media resolve service", () => {
  it("skips the media resolve service for a US-only team", async () => {
    const res = response();
    await mapController(request({ usOnly: true }), res);
    expect(resolveViaAvgrab).not.toHaveBeenCalled();
    expect(getMapResults).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("still asks the media resolve service for other teams", async () => {
    const res = response();
    await mapController(request(null), res);
    expect(resolveViaAvgrab).toHaveBeenCalledOnce();
    expect(getMapResults).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
