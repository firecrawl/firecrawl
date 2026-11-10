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
      tags: "wifi",
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
