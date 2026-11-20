import { describe, expect, it } from "vitest";
import { parseWithSchema } from "./postprocess";

describe("schema key aliases", () => {
  it("does not map an unrelated non-Latin field onto the last schema property", () => {
    const input = { 名称: "tea", 价格: 12, 库存: 3 };
    const schema = {
      properties: { 名称: { type: "string" }, 价格: { type: "number" } },
    };
    expect(parseWithSchema(input, schema)).toEqual(input);
  });

  it("matches Cyrillic casing without confusing distinct property names", () => {
    expect(
      parseWithSchema(
        { НАЗВАНИЕ: "чай" },
        {
          properties: {
            название: { type: "string" },
            цена: { type: "number" },
          },
        },
      ),
    ).toEqual({ название: "чай" });
  });

  it("keeps accented letters distinct from names that omit them", () => {
    expect(
      parseWithSchema(
        { "CAFÉ-NAME": "Bistro" },
        {
          properties: {
            café_name: { type: "string" },
            caf_name: { type: "string" },
          },
        },
      ),
    ).toEqual({ café_name: "Bistro" });
  });

  it("recognizes canonically equivalent combining accents", () => {
    expect(
      parseWithSchema(
        { "CAFE\u0301 NAME": "Bistro" },
        { properties: { café_name: { type: "string" } } },
      ),
    ).toEqual({ café_name: "Bistro" });
  });

  it("retains meaningful combining marks in Indic property names", () => {
    expect(
      parseWithSchema(
        { "किताब नाम": "book" },
        {
          properties: {
            किताब_नाम: { type: "string" },
            कतब_नम: { type: "string" },
          },
        },
      ),
    ).toEqual({ किताब_नाम: "book" });
  });

  it.each([
    ["first_name", "firstname"],
    ["firstname", "first_name"],
  ])(
    "does not choose between colliding aliases in schema order %j",
    (...keys) => {
      const schema = {
        properties: Object.fromEntries(
          keys.map(key => [key, { type: "string" }]),
        ),
      };
      expect(parseWithSchema({ "First Name": "Ada" }, schema)).toEqual({
        "First Name": "Ada",
      });
    },
  );

  it("does not infer an alias from an empty normalized name", () => {
    expect(
      parseWithSchema(
        { "!!!": "keep" },
        { properties: { "!": { type: "string" }, "?": { type: "string" } } },
      ),
    ).toEqual({ "!!!": "keep" });
  });

  it("applies the same rules inside object arrays", () => {
    expect(
      parseWithSchema(
        { Rows: [{ "商品 名": "tea", 在庫: 4 }] },
        {
          properties: {
            rows: {
              type: "array",
              items: {
                properties: {
                  商品名: { type: "string" },
                  価格: { type: "number" },
                },
              },
            },
          },
        },
      ),
    ).toEqual({ rows: [{ 商品名: "tea", 在庫: 4 }] });
  });

  it("keeps exact keys even when their normalized forms collide", () => {
    const input = { first_name: "Ada", firstname: "Grace", "!": "literal" };
    expect(
      parseWithSchema(input, {
        properties: Object.fromEntries(
          Object.keys(input).map(key => [key, { type: "string" }]),
        ),
      }),
    ).toEqual(input);
  });

  it("preserves ordinary ASCII case and separator aliases", () => {
    expect(
      parseWithSchema(
        { "First Name": "Ada", "POST-CODE": "12345", other: "keep" },
        {
          properties: {
            first_name: { type: "string" },
            postCode: { type: "string" },
          },
        },
      ),
    ).toEqual({ first_name: "Ada", postCode: "12345", other: "keep" });
  });

  it("does not mutate the input or schema", () => {
    const input = { "First Name": "Ada" };
    const schema = { properties: { first_name: { type: "string" } } };
    const before = JSON.stringify({ input, schema });
    parseWithSchema(input, schema);
    expect(JSON.stringify({ input, schema })).toBe(before);
  });
});

describe("Unicode casing and separator order", () => {
  it.each([
    ["ΟΣ", "οσ"],
    ["ΟΣ", "ος"],
    ["οσ", "ΟΣ"],
    ["ος", "οσ"],
    ["Straße", "STRASSE"],
    ["STRAẞE", "Straße"],
    ["Strasse", "Straße"],
    ["μg", "µG"],
    ["st", "ﬅ"],
    ["st", "ﬆ"],
    ["é", "e-\u0301"],
    ["ΐ", "ι-\u0308\u0301"],
  ])("maps the caseless alias %s <- %s", (canonical, alias) => {
    expect(
      parseWithSchema(
        { [alias]: "value" },
        { properties: { [canonical]: { type: "string" } } },
      ),
    ).toEqual({ [canonical]: "value" });
  });

  it.each([
    ["ΟΣ", "οσ", "ο-σ"],
    ["οσ", "ΟΣ", "ο-σ"],
    ["Straße", "Strasse", "STRASSE"],
    ["Strasse", "Straße", "STRASSE"],
  ])("retains ambiguous caseless input for %s / %s", (first, second, alias) => {
    const input = { [alias]: "keep" };
    expect(
      parseWithSchema(input, {
        properties: {
          [first]: { type: "string" },
          [second]: { type: "string" },
        },
      }),
    ).toEqual(input);
  });

  it("preserves exact spelling even when case folding creates collisions", () => {
    const input = { ΟΣ: "one", οσ: "two", Straße: "three", Strasse: "four" };
    expect(
      parseWithSchema(input, {
        properties: Object.fromEntries(
          Object.keys(input).map(key => [key, { type: "string" }]),
        ),
      }),
    ).toEqual(input);
  });

  it("keeps dotless, dotted and ordinary i keys distinct", () => {
    expect(
      parseWithSchema(
        { ID: "ordinary", ıd: "dotless", İD: "dotted" },
        {
          properties: {
            id: { type: "string" },
            ıd: { type: "string" },
            "i\u0307d": { type: "string" },
          },
        },
      ),
    ).toEqual({ id: "ordinary", ıd: "dotless", "i\u0307d": "dotted" });
  });
});
