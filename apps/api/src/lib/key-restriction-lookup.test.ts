const mocks = vi.hoisted(() => ({
  // Config rows by API key id.
  rows: {} as Record<
    number,
    { allowed_formats: unknown; allowed_endpoints: unknown }[]
  >,
  where: vi.fn(),
  query: vi.fn(),
  getValue: vi.fn(),
  setValue: vi.fn(),
}));

vi.mock("../db/connection", async () => {
  const dialect = new (await import("drizzle-orm/pg-core")).PgDialect();
  // Answers with the rows of the key id the query filters on, so a lookup
  // that asked for another key's config would get that key's rows.
  let keyId: unknown;
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "from"]) chain[name] = () => chain;
  chain.where = (condition: Parameters<typeof dialect.sqlToQuery>[0]) => {
    const query = dialect.sqlToQuery(condition);
    mocks.where(query.sql);
    keyId = query.params[0];
    return chain;
  };
  chain.limit = async () => {
    mocks.query();
    return mocks.rows[keyId as number] ?? [];
  };
  return { dbRr: chain };
});
vi.mock("../services/redis", () => ({
  getValue: mocks.getValue,
  setValue: mocks.setValue,
  deleteKey: vi.fn(),
}));

import {
  checkKeyEndpointRestriction,
  checkKeyFormatRestriction,
  checkKeyProfileRestriction,
} from "./key-restriction";

const scrapeOnly = [{ allowed_formats: [], allowed_endpoints: ["scrape"] }];
const markdownOnly = [{ allowed_formats: ["markdown"], allowed_endpoints: [] }];

describe("which keys have their restriction config looked up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getValue.mockResolvedValue(null);
    mocks.setValue.mockResolvedValue(undefined);
    mocks.query.mockReturnValue(undefined);
    mocks.rows = {};
  });

  it("costs an unrestricted key on an unflagged team no cache or database read", async () => {
    mocks.rows = { 7: scrapeOnly };
    const key = { api_key_id: 7, flags: null, is_key_restricted: false };

    expect(await checkKeyEndpointRestriction("/v2/team/activity", key)).toEqual(
      { allowed: true },
    );
    expect(await checkKeyFormatRestriction(["rawHtml"], [], key)).toEqual({
      allowed: true,
    });
    expect(await checkKeyProfileRestriction(key)).toEqual({ allowed: true });
    expect(mocks.getValue).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("enforces a restricted key's endpoint allowlist on an unflagged team", async () => {
    mocks.rows = { 7: scrapeOnly };
    const key = { api_key_id: 7, flags: null, is_key_restricted: true };

    expect(await checkKeyEndpointRestriction("/v2/scrape", key)).toEqual({
      allowed: true,
    });
    for (const url of [
      "/v2/team/activity",
      "/v2/team/credit-usage",
      "/v2/slack/installation",
      "/v2/team/siem",
      "/v2/map",
      "/v0/scrape",
    ]) {
      expect(await checkKeyEndpointRestriction(url, key)).toMatchObject({
        allowed: false,
        status: 403,
      });
    }
  });

  it("loads the config of the key that made the request", async () => {
    mocks.rows = { 7: scrapeOnly, 8: markdownOnly };
    const key = { api_key_id: 8, flags: null, is_key_restricted: true };

    expect(await checkKeyEndpointRestriction("/v2/map", key)).toEqual({
      allowed: true,
    });
    expect(mocks.where).toHaveBeenCalledWith(
      '"key_restriction_config"."api_key_id" = $1',
    );
  });

  it("refuses a saved browser profile unless the endpoint allowlist names profiles", async () => {
    mocks.rows = { 7: scrapeOnly };
    const key = { api_key_id: 7, flags: null, is_key_restricted: true };
    const profile = { name: "work", saveChanges: true };

    expect(await checkKeyProfileRestriction(key)).toMatchObject({
      allowed: false,
      status: 403,
    });
    expect(
      await checkKeyFormatRestriction(["markdown"], [], key, profile),
    ).toMatchObject({ allowed: false, status: 403 });
    expect(await checkKeyFormatRestriction(["markdown"], [], key)).toEqual({
      allowed: true,
    });

    mocks.rows = {
      7: [{ allowed_formats: [], allowed_endpoints: ["scrape", "profiles"] }],
    };
    expect(await checkKeyProfileRestriction(key)).toEqual({ allowed: true });
    expect(
      await checkKeyFormatRestriction(["markdown"], [], key, profile),
    ).toEqual({ allowed: true });

    // Only the formats are restricted, so every endpoint stays open.
    mocks.rows = { 7: markdownOnly };
    expect(await checkKeyProfileRestriction(key)).toEqual({ allowed: true });
  });

  it("enforces a restricted key's format allowlist on an unflagged team", async () => {
    mocks.rows = { 7: markdownOnly };
    const key = { api_key_id: 7, flags: {}, is_key_restricted: true };

    expect(await checkKeyFormatRestriction(["markdown"], [], key)).toEqual({
      allowed: true,
    });
    expect(
      await checkKeyFormatRestriction(["markdown", "rawHtml"], [], key),
    ).toMatchObject({ allowed: false, status: 403 });
  });

  it("still looks up every key of a flagged team, with or without the chunk's marker", async () => {
    mocks.rows = { 7: scrapeOnly };

    // An auth chunk cached before the marker existed has no is_key_restricted.
    expect(
      await checkKeyEndpointRestriction("/v2/map", {
        api_key_id: 7,
        flags: { keyRestriction: true },
      }),
    ).toMatchObject({ allowed: false, status: 403 });

    expect(
      await checkKeyEndpointRestriction("/v2/map", {
        api_key_id: 8,
        flags: { keyRestriction: true },
        is_key_restricted: false,
      }),
    ).toEqual({ allowed: true });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a restricted key's config cannot be loaded", async () => {
    mocks.query.mockImplementation(() => {
      throw new Error("replica down");
    });
    const key = { api_key_id: 7, flags: null, is_key_restricted: true };

    expect(await checkKeyEndpointRestriction("/v2/scrape", key)).toMatchObject({
      allowed: false,
      status: 500,
    });
    expect(
      await checkKeyFormatRestriction(["markdown"], [], key),
    ).toMatchObject({ allowed: false, status: 500 });
  });

  it("never restricts a credential without a key id", async () => {
    mocks.rows = { 7: scrapeOnly };

    for (const key of [
      undefined,
      null,
      {
        api_key_id: 0,
        flags: { keyRestriction: true },
        is_key_restricted: true,
      },
    ]) {
      expect(await checkKeyEndpointRestriction("/v2/map", key)).toEqual({
        allowed: true,
      });
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
