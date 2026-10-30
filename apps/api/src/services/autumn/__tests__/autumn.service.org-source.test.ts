/**
 * The org comes from the caller, and nowhere else: AutumnService must have no
 * way to look one up. controllers/auth and lib/team-org are mocked with
 * factories that throw, so a service that reaches for the ACUC again — directly
 * or through the shared helper — fails this file at import time rather than
 * quietly resolving its own org.
 */

import { vi } from "vitest";

// The seam: importing either module at all is the failure.
vi.mock("../../../controllers/auth", () => {
  throw new Error("autumn.service must not import controllers/auth");
});

vi.mock("../../../lib/team-org", () => {
  throw new Error("autumn.service must not import lib/team-org");
});

vi.mock("../client", () => ({
  autumnClient: null,
}));

vi.mock("../../../db/connection", () => ({
  dbRr: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  },
}));

vi.mock("../../../config", () => ({
  // Stubbed so importing the real config (which parses env) is avoided.
  config: {
    FIREBILL_URL: "http://firebill.test",
    FIREBILL_SECRET: "fb-secret",
  },
}));

// Import AFTER the mocks are wired up.
import { AutumnService } from "../autumn.service";

const CALLER_ORG = "3f2c1b8e-7a4d-4c1e-9b6a-0d5e8f2a1c74";

const mockFetch = vi.fn<(url: any, init?: any) => Promise<Response>>();
const sentBody = () => JSON.parse(mockFetch.mock.calls[0]![1].body);

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ success: true, allowed: true, remaining: 0 }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AutumnService resolves no org of its own", () => {
  it("checks credits against the org the caller handed in", async () => {
    const result = await new AutumnService().checkCredits({
      teamId: "team-1",
      orgId: CALLER_ORG,
      value: 42,
    });

    expect(result).toEqual({ allowed: true, remaining: 0 });
    expect(sentBody()).toMatchObject({
      customer_id: CALLER_ORG,
      entity_id: "team-1",
    });
  });

  it("tracks credits against the org the caller handed in", async () => {
    await new AutumnService().trackCredits({
      teamId: "team-1",
      orgId: CALLER_ORG,
      value: 7,
    });

    expect(sentBody()).toMatchObject({
      customer_id: CALLER_ORG,
      entity_id: "team-1",
    });
  });
});
