const mocks = vi.hoisted(() => ({
  rows: [] as { allowed_formats: unknown; allowed_endpoints: unknown }[],
  query: vi.fn(),
  getValue: vi.fn(),
  setValue: vi.fn(),
}));

vi.mock("../db/connection", () => {
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "from", "where"]) chain[name] = () => chain;
  chain.limit = async () => {
    mocks.query();
    return mocks.rows;
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
} from "./key-restriction";

const scrapeOnly = [{ allowed_formats: [], allowed_endpoints: ["scrape"] }];
const markdownOnly = [{ allowed_formats: ["markdown"], allowed_endpoints: [] }];

describe("which keys have their restriction config looked up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getValue.mockResolvedValue(null);
    mocks.setValue.mockResolvedValue(undefined);
    mocks.query.mockReturnValue(undefined);
    mocks.rows = [];
  });

  it("costs an unrestricted key on an unflagged team no cache or database read", async () => {
    mocks.rows = scrapeOnly;
    const key = { api_key_id: 7, flags: null, is_key_restricted: false };

    expect(await checkKeyEndpointRestriction("/v2/team/activity", key)).toEqual(
      { allowed: true },
    );
    expect(await checkKeyFormatRestriction(["rawHtml"], [], key)).toEqual({
      allowed: true,
    });
    expect(mocks.getValue).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("enforces a restricted key's endpoint allowlist on an unflagged team", async () => {
    mocks.rows = scrapeOnly;
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

  it("enforces a restricted key's format allowlist on an unflagged team", async () => {
    mocks.rows = markdownOnly;
    const key = { api_key_id: 7, flags: {}, is_key_restricted: true };

    expect(await checkKeyFormatRestriction(["markdown"], [], key)).toEqual({
      allowed: true,
    });
    expect(
      await checkKeyFormatRestriction(["markdown", "rawHtml"], [], key),
    ).toMatchObject({ allowed: false, status: 403 });
  });

  it("still looks up every key of a flagged team, with or without the chunk's marker", async () => {
    mocks.rows = scrapeOnly;

    // An auth chunk cached before the marker existed has no is_key_restricted.
    expect(
      await checkKeyEndpointRestriction("/v2/map", {
        api_key_id: 7,
        flags: { keyRestriction: true },
      }),
    ).toMatchObject({ allowed: false, status: 403 });

    mocks.rows = [];
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
    mocks.rows = scrapeOnly;

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
