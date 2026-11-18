import {
  AlexandriaQueryError,
  convertAlexandriaOptions,
  parseAlexandriaQuery,
} from "./alexandria-query";

const fails = (query: Record<string, unknown>, message: RegExp) =>
  expect(() => parseAlexandriaQuery(query)).toThrow(message);

describe("parseAlexandriaQuery", () => {
  it("nests dotted keys and lists repeated keys", () => {
    expect(
      parseAlexandriaQuery({
        query: "coffee",
        "filters.country": "US",
        "filters.rating.min": "4",
        tags: ["wifi", "outdoor"],
      }),
    ).toEqual({
      options: {
        query: "coffee",
        filters: { country: "US", rating: { min: "4" } },
        tags: ["wifi", "outdoor"],
      },
    });
  });

  it("keeps an escaped dot in the key", () => {
    expect(parseAlexandriaQuery({ "meta\\.version": "4" }).options).toEqual({
      "meta.version": "4",
    });
  });

  it("reads timeout and version as request fields, and options. as provider options", () => {
    expect(
      parseAlexandriaQuery({
        timeout: "30000",
        version: "1.2.0",
        "options.timeout": "5",
      }),
    ).toEqual({
      options: { timeout: "5" },
      timeout: "30000",
      version: "1.2.0",
    });
  });

  it("refuses a value that is also an object, in either order", () => {
    fails(
      { filters: "x", "filters.country": "US" },
      /both a value and an object/,
    );
    fails(
      { "filters.country": "US", filters: "x" },
      /both a value and an object/,
    );
  });

  it("refuses credentials and zero data retention in the URL", () => {
    fails({ api_key: "fc-1" }, /Authorization header/);
    fails({ zeroDataRetention: "true" }, /must use POST/);
  });

  it("refuses unsafe, empty, too deep and too many keys", () => {
    fails({ "__proto__.polluted": "1" }, /not allowed/);
    fails({ "a.constructor.b": "1" }, /not allowed/);
    fails({ "a..b": "1" }, /empty segment/);
    fails({ [Array.from({ length: 11 }, () => "a").join(".")]: "1" }, /deeper/);
    fails({ tags: Array.from({ length: 201 }, String) }, /at most 200/);
    fails({ timeout: ["1", "2"] }, /only be given once/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("parseAlexandriaQuery with the contract's option names", () => {
  const declared = (...names: string[]) => new Set(names);

  it("keeps a declared option whose name has dots whole", () => {
    expect(
      parseAlexandriaQuery(
        { "meta.version": "4", "filters.country": "US" },
        declared("meta.version", "filters"),
      ).options,
    ).toEqual({ "meta.version": "4", filters: { country: "US" } });
  });

  it("gives timeout and version to a capability that declares them", () => {
    expect(
      parseAlexandriaQuery(
        { timeout: "5", version: "2" },
        declared("timeout", "version"),
      ),
    ).toEqual({ options: { timeout: "5", version: "2" } });
  });

  it("refuses credentials in the URL however they are reached", () => {
    const refuses = (query: Record<string, unknown>, names: string[] = []) =>
      expect(() => parseAlexandriaQuery(query, declared(...names))).toThrow(
        /Authorization header|must use POST/,
      );
    refuses({ api_key: "x" });
    refuses({ "options.api_key": "x" });
    refuses({ "options.access_token": "x" });
    refuses({ "options.zeroDataRetention": "true" });
    refuses({ "auth.token": "x" });
    refuses({ "meta\\.key": "x" });
    refuses({ key: "isbn" }, ["key"]);
    refuses({ "options.token": "next" }, ["token"]);
    refuses({ api_key: "x" }, ["api_key"]);
    refuses({ zeroDataRetention: "true" }, ["zeroDataRetention"]);
    refuses({ q: "fc-1e914bb5895149f8b754f58e2d4650a7" });
    refuses({ tags: ["a", "FC-1E914BB5895149F8B754F58E2D4650A7"] });
  });

  it("matches options.-prefixed keys against the contract too", () => {
    expect(
      parseAlexandriaQuery(
        { "options.meta.version": "4" },
        declared("meta.version"),
      ).options,
    ).toEqual({ "meta.version": "4" });
  });

  it("refuses the same declared option given twice", () => {
    expect(() =>
      parseAlexandriaQuery(
        { "meta.version": "4", "options.meta.version": "5" },
        declared("meta.version"),
      ),
    ).toThrow(/given twice/);
  });
});

describe("convertAlexandriaOptions", () => {
  const types = new Map([
    ["limit", "number"],
    ["open", "boolean"],
    ["zip", "string"],
    ["ids", "number[]"],
    ["tags", "string[]"],
    ["items", "object[]"],
    ["filters", "object"],
  ]);

  it("converts top-level values to their declared types", () => {
    expect(
      convertAlexandriaOptions(
        {
          limit: "10",
          open: "true",
          zip: "02139",
          ids: "7",
          tags: "wifi",
          filters: { open: "true" },
          other: "1",
        },
        types,
      ),
    ).toEqual({
      limit: 10,
      open: true,
      zip: "02139",
      ids: [7],
      tags: ["wifi"],
      filters: { open: "true" },
      other: "1",
    });
  });

  it("builds lists of objects from indexes", () => {
    expect(
      convertAlexandriaOptions(
        { items: { "0": { sku: "A1" }, "1": { sku: "B7" } } },
        types,
      ),
    ).toEqual({ items: [{ sku: "A1" }, { sku: "B7" }] });
    expect(() =>
      convertAlexandriaOptions({ items: { "0": {}, "2": {} } }, types),
    ).toThrow(AlexandriaQueryError);
  });

  it("leaves values that do not convert for the Exchange to report", () => {
    expect(
      convertAlexandriaOptions({ limit: "ten", open: "yes" }, types),
    ).toEqual({ limit: "ten", open: "yes" });
  });
});
