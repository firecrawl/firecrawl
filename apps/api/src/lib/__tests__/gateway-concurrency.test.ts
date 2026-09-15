import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config", () => ({
  config: {
    USE_DB_AUTHENTICATION: true,
    GATEWAY_GHOST_CONCURRENCY_CONTRACTED: 100,
    GATEWAY_GHOST_CONCURRENCY_SELF_SERVE: 5,
  },
}));

// The Drizzle chain the lookup builds. Every step returns the chain and the
// terminal `limit` answers with whatever the test staged.
const dbState = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as Error | null,
  selects: 0,
}));

vi.mock("../../db/connection", () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: async () => {
      if (dbState.error) throw dbState.error;
      return dbState.rows;
    },
  };
  return {
    dbRr: {
      select: () => {
        dbState.selects += 1;
        return chain;
      },
    },
  };
});

vi.mock("../../services/redis", () => ({
  getValue: vi.fn(),
  setValue: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: { warn: vi.fn() },
}));

import { config } from "../../config";
import { getValue, setValue } from "../../services/redis";
import { logger } from "../logger";
import {
  getGatewayConcurrencyLimit,
  resolveGatewayConcurrencyLimit,
  withGatewayFloor,
} from "../gateway-concurrency";

const mutableConfig = config as { USE_DB_AUTHENTICATION?: boolean };
const mockedGetValue = getValue as unknown as Mock;
const mockedSetValue = setValue as unknown as Mock;
const mockedWarn = logger.warn as unknown as Mock;

const teamId = "11111111-1111-4111-8111-111111111111";
const cacheKey = `gateway-concurrency:${teamId}`;

const contracted = {
  gateway_enabled: true,
  partner_org_id: "org-partner",
  partner_flags: { signedContract: true },
};
const selfServe = {
  gateway_enabled: true,
  partner_org_id: "org-partner",
  partner_flags: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mutableConfig.USE_DB_AUTHENTICATION = true;
  dbState.rows = [];
  dbState.error = null;
  dbState.selects = 0;
  mockedGetValue.mockResolvedValue(null);
  mockedSetValue.mockResolvedValue(undefined);
});

describe("withGatewayFloor", () => {
  it("keeps the plan limit when there is no gateway figure", () => {
    expect(withGatewayFloor(2, null)).toBe(2);
  });

  it("raises the plan limit to the gateway figure", () => {
    expect(withGatewayFloor(2, 5)).toBe(5);
    expect(withGatewayFloor(2, 100)).toBe(100);
  });

  it("never lowers a plan limit that is already higher", () => {
    // Autumn's fail-open value, or a ghost someone gave an override.
    expect(withGatewayFloor(200, 100)).toBe(200);
  });

  it("leaves an unlimited team unlimited", () => {
    expect(withGatewayFloor(null, 5)).toBeNull();
    expect(withGatewayFloor(null, null)).toBeNull();
  });
});

describe("resolveGatewayConcurrencyLimit", () => {
  it("answers null for a team that is not a gateway ghost", () => {
    expect(resolveGatewayConcurrencyLimit(undefined)).toBeNull();
  });

  it("drops a ghost back to its plan when the partner switched funding off", () => {
    expect(
      resolveGatewayConcurrencyLimit({ ...contracted, gateway_enabled: false }),
    ).toBeNull();
    expect(
      resolveGatewayConcurrencyLimit({ ...contracted, gateway_enabled: null }),
    ).toBeNull();
  });

  it("answers null when the integration names no partner org to fund from", () => {
    expect(
      resolveGatewayConcurrencyLimit({ ...contracted, partner_org_id: null }),
    ).toBeNull();
  });

  it("gives the contracted figure when the partner org has signedContract", () => {
    expect(resolveGatewayConcurrencyLimit(contracted)).toBe(100);
  });

  it("gives the self-serve figure otherwise", () => {
    expect(resolveGatewayConcurrencyLimit(selfServe)).toBe(5);
    expect(
      resolveGatewayConcurrencyLimit({
        ...selfServe,
        partner_flags: { signedContract: false },
      }),
    ).toBe(5);
  });

  it("only counts the literal true as a signed contract", () => {
    for (const partner_flags of [
      { signedContract: "true" },
      { signedContract: 1 },
      null,
      undefined,
      [],
      "signedContract",
    ]) {
      expect(
        resolveGatewayConcurrencyLimit({ ...selfServe, partner_flags }),
      ).toBe(5);
    }
  });
});

describe("getGatewayConcurrencyLimit", () => {
  it("answers null without touching Redis or the DB when DB auth is off", async () => {
    mutableConfig.USE_DB_AUTHENTICATION = false;

    expect(await getGatewayConcurrencyLimit(teamId)).toBeNull();
    expect(mockedGetValue).not.toHaveBeenCalled();
    expect(dbState.selects).toBe(0);
  });

  it("answers null without touching Redis or the DB for a preview team", async () => {
    expect(await getGatewayConcurrencyLimit("preview")).toBeNull();
    expect(await getGatewayConcurrencyLimit("preview_abc")).toBeNull();
    expect(mockedGetValue).not.toHaveBeenCalled();
    expect(dbState.selects).toBe(0);
  });

  it("serves a cached figure without reading the DB", async () => {
    mockedGetValue.mockResolvedValue("100");

    expect(await getGatewayConcurrencyLimit(teamId)).toBe(100);
    expect(mockedGetValue).toHaveBeenCalledWith(cacheKey);
    expect(dbState.selects).toBe(0);
    expect(mockedSetValue).not.toHaveBeenCalled();
  });

  it("serves the cached negative without reading the DB", async () => {
    mockedGetValue.mockResolvedValue("none");

    expect(await getGatewayConcurrencyLimit(teamId)).toBeNull();
    expect(dbState.selects).toBe(0);
  });

  it("treats a malformed cache entry as a miss", async () => {
    mockedGetValue.mockResolvedValue("lots");
    dbState.rows = [contracted];

    expect(await getGatewayConcurrencyLimit(teamId)).toBe(100);
    expect(dbState.selects).toBe(1);
    expect(mockedWarn).toHaveBeenCalledWith(
      "Ignoring malformed gateway concurrency cache entry",
      { teamId },
    );
  });

  it("caches a negative for a team that is not a gateway ghost", async () => {
    expect(await getGatewayConcurrencyLimit(teamId)).toBeNull();
    expect(dbState.selects).toBe(1);
    expect(mockedSetValue).toHaveBeenCalledWith(cacheKey, "none", 60);
  });

  it("resolves and caches the contracted figure", async () => {
    dbState.rows = [contracted];

    expect(await getGatewayConcurrencyLimit(teamId)).toBe(100);
    expect(mockedSetValue).toHaveBeenCalledWith(cacheKey, "100", 60);
  });

  it("resolves and caches the self-serve figure", async () => {
    dbState.rows = [selfServe];

    expect(await getGatewayConcurrencyLimit(teamId)).toBe(5);
    expect(mockedSetValue).toHaveBeenCalledWith(cacheKey, "5", 60);
  });

  it("caches a negative when the partner switched funding off", async () => {
    dbState.rows = [{ ...contracted, gateway_enabled: false }];

    expect(await getGatewayConcurrencyLimit(teamId)).toBeNull();
    expect(mockedSetValue).toHaveBeenCalledWith(cacheKey, "none", 60);
  });

  it("fails open to null on a DB error and does not cache it", async () => {
    dbState.error = new Error("replica down");

    expect(await getGatewayConcurrencyLimit(teamId)).toBeNull();
    expect(mockedSetValue).not.toHaveBeenCalled();
    expect(mockedWarn).toHaveBeenCalledWith(
      "Failed to load gateway concurrency limit",
      expect.objectContaining({ teamId }),
    );
  });

  it("still answers from the DB when the cache read fails", async () => {
    mockedGetValue.mockRejectedValue(new Error("redis down"));
    dbState.rows = [selfServe];

    expect(await getGatewayConcurrencyLimit(teamId)).toBe(5);
    expect(dbState.selects).toBe(1);
  });

  it("still answers when the cache write fails", async () => {
    mockedSetValue.mockRejectedValue(new Error("redis down"));
    dbState.rows = [contracted];

    expect(await getGatewayConcurrencyLimit(teamId)).toBe(100);
    expect(mockedWarn).toHaveBeenCalledWith(
      "Failed to cache gateway concurrency limit",
      expect.objectContaining({ teamId }),
    );
  });
});
