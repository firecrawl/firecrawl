import { describe, expect, it } from "vitest";
import { parseWithSchema } from "./postprocess";

const stringSchema = { type: "string" };
const parse = (json: string) => JSON.parse(json);

function schemaFor(key: string) {
  return parse(
    `{"type":"object","properties":{${JSON.stringify(key)}:{"type":"string"}},"required":[${JSON.stringify(key)}]}`,
  );
}

describe("deterministic JSON own property names", () => {
  it.each([{}, { type: "object", properties: {} }])(
    "preserves literal JSON property names with schema %j",
    schema => {
      const value = parse(
        '{"__proto__":{"name":"kept"},"constructor":"ctor","prototype":"data","toString":"text","hasOwnProperty":"own"}',
      );
      const result = parseWithSchema(value, schema);
      expect(result).toEqual(value);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(Object.hasOwn(result as object, "__proto__")).toBe(true);
      expect(JSON.stringify(result)).toBe(JSON.stringify(value));
    },
  );

  it("remaps a schema alias to an own __proto__ property", () => {
    const schema = schemaFor("__proto__");
    expect(parseWithSchema({ "__ proto __": "kept" }, schema)).toEqual(
      parse('{"__proto__":"kept"}'),
    );
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "fills an omitted required %s instead of finding an inherited property",
    key => {
      expect(parseWithSchema({}, schemaFor(key))).toEqual(
        parse(`{${JSON.stringify(key)}:""}`),
      );
    },
  );

  it("builds required object defaults with own reserved property names", () => {
    expect(parseWithSchema(null, schemaFor("__proto__"))).toEqual(
      parse('{"__proto__":""}'),
    );
  });

  it("preserves reserved names through nested arrays and null coercion", () => {
    const value = parse(
      '{"rows":[{"__proto__":"  kept  ","constructor":null}]}',
    );
    const schema = parse(
      '{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"integer"}},"required":["constructor"]}}}}',
    );
    expect(parseWithSchema(value, schema)).toEqual(
      parse('{"rows":[{"__proto__":"kept","constructor":0}]}'),
    );
  });

  it("does not deduplicate records after losing their only property", () => {
    const values = parse(
      '[{"__proto__":"first"},{"__proto__":"second"},{"__proto__":"first"}]',
    );
    expect(
      parseWithSchema(values, { type: "array", items: schemaFor("__proto__") }),
    ).toEqual(parse('[{"__proto__":"first"},{"__proto__":"second"}]'));
  });

  it("keeps ordinary object prototypes and leaves the input unchanged", () => {
    const value = { display_name: "  A  B  ", nested: { count: 3 } };
    const before = JSON.stringify(value);
    const schema = {
      type: "object",
      properties: { displayName: stringSchema },
    };
    const result = parseWithSchema(value, schema);
    expect(result).toEqual({ displayName: "A B", nested: { count: 3 } });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("keeps schema null/default behavior and ordinary duplicate removal", () => {
    const schema = {
      type: "object",
      properties: {
        optional: stringSchema,
        nullable: { type: ["string", "null"] },
        count: { type: "integer" },
        rows: { type: "array" },
      },
      required: ["count"],
    };
    expect(
      parseWithSchema(
        { optional: null, nullable: null, rows: [{ id: 1 }, { id: 1 }] },
        schema,
      ),
    ).toEqual({
      nullable: null,
      rows: [{ id: 1 }],
      count: 0,
    });
  });
});
