const mocks = vi.hoisted(() => ({
  rows: [] as { billing_address: unknown }[],
  query: vi.fn(),
  orderBy: vi.fn(),
  getValue: vi.fn(),
  setValue: vi.fn(),
}));

vi.mock("../db/connection", () => {
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "from", "innerJoin", "where"])
    chain[name] = () => chain;
  chain.orderBy = async (...args: unknown[]) => {
    mocks.orderBy(...args);
    mocks.query();
    return mocks.rows;
  };
  return { dbRr: chain };
});
vi.mock("../services/redis", () => ({
  getValue: mocks.getValue,
  setValue: mocks.setValue,
}));

import { asc } from "drizzle-orm";
import * as schema from "../db/schema";
import { billingCountryForTeam } from "./billing-country";

describe("billingCountryForTeam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orderBy.mockReset();
    mocks.getValue.mockResolvedValue(null);
    mocks.setValue.mockResolvedValue(undefined);
    mocks.query.mockReturnValue(undefined);
    mocks.rows = [];
  });

  it("takes the first member with a valid country and caches it", async () => {
    mocks.rows = [
      { billing_address: null },
      { billing_address: { country: "xx1" } },
      { billing_address: { country: "ZZ" } },
      { billing_address: { country: " de " } },
      { billing_address: { country: "FR" } },
    ];
    await expect(billingCountryForTeam("team")).resolves.toBe("DE");
    expect(mocks.setValue).toHaveBeenCalledWith(
      "billing-country:team",
      "DE",
      3600,
    );
  });

  it("asks for the members oldest first", async () => {
    await billingCountryForTeam("team");
    expect(mocks.orderBy).toHaveBeenCalledTimes(1);
    expect(mocks.orderBy.mock.calls[0]).toEqual([
      asc(schema.user_teams.created_at),
    ]);
  });

  it("caches a team with no billing country so it is not queried again", async () => {
    await expect(billingCountryForTeam("team")).resolves.toBeUndefined();
    expect(mocks.setValue).toHaveBeenCalledWith(
      "billing-country:team",
      "",
      3600,
    );
    mocks.getValue.mockResolvedValue("");
    await expect(billingCountryForTeam("team")).resolves.toBeUndefined();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("serves a cached country without querying", async () => {
    mocks.getValue.mockResolvedValue("US");
    await expect(billingCountryForTeam("team")).resolves.toBe("US");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a cache read",
      () => mocks.getValue.mockRejectedValue(new Error("redis down")),
    ],
    [
      "the query",
      () =>
        mocks.orderBy.mockImplementation(() => {
          throw new Error("db down");
        }),
    ],
    [
      "a cache write",
      () => {
        mocks.rows = [{ billing_address: { country: "DE" } }];
        mocks.setValue.mockRejectedValue(new Error("redis down"));
      },
    ],
  ])("reads a failed %s as unknown", async (_, fail) => {
    fail();
    await expect(billingCountryForTeam("team")).resolves.toBeUndefined();
  });

  it("reads a lookup that never answers as unknown", async () => {
    vi.useFakeTimers();
    try {
      mocks.getValue.mockReturnValue(new Promise(() => {}));
      const pending = billingCountryForTeam("team");
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
