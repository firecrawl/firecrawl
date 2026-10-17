import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { dereferenceSchema } from "../extract/helpers/dereference-schema";
import { mixSchemaObjects } from "../extract/helpers/mix-schema-objs";
import { mixSchemaObjects_F0 } from "../extract/fire-0/helpers/mix-schema-objs-f0";
import { transformArrayToObject } from "../extract/helpers/transform-array-to-obj";
import { transformArrayToObject_F0 } from "../extract/fire-0/helpers/transform-array-to-obj-f0";
import { deduplicateObjectsArray } from "../extract/helpers/deduplicate-objs-array";
import { deduplicateObjectsArray_F0 } from "../extract/fire-0/helpers/deduplicate-objs-array-f0";
import { mergeNullValObjs } from "../extract/helpers/merge-null-val-objs";
import { mergeNullValObjs_F0 } from "../extract/fire-0/helpers/merge-null-val-objs-f0";
for (const [mix, transform, deduplicate, merge] of [
  [
    mixSchemaObjects,
    transformArrayToObject,
    deduplicateObjectsArray,
    mergeNullValObjs,
  ],
  [
    mixSchemaObjects_F0,
    transformArrayToObject_F0,
    deduplicateObjectsArray_F0,
    mergeNullValObjs_F0,
  ],
] as const) {
  // Keep the original one-argument consumer callable in the before run. Its
  // missing schema-aware behavior must fail the assertion, not TypeScript build.
  const deduplicateForSchema: (
    values: { [key: string]: any[] },
    schema?: any,
  ) => { [key: string]: any[] } = deduplicate;
  describe(mix.name, () => {
    it("preserves schema-declared arrays of arrays", async () => {
      const schema = {
        type: "object",
        properties: {
          matrix: {
            type: "array",
            items: { type: "array", items: { type: "number" } },
          },
        },
      };
      const data = {
        matrix: [
          [1, 2],
          [3, 4],
        ],
      };
      const validate = new Ajv().compile(schema);
      expect(validate(data)).toBe(true);
      const result = await mix(schema, {}, data);
      expect(validate(result)).toBe(true);
      expect(result).toEqual(data);
    });
    it("preserves nested object matrix fields", async () => {
      const schema = {
        properties: {
          nested: {
            type: "object",
            properties: {
              matrix: {
                type: "array",
                items: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      };
      const data = { nested: { matrix: [["a"], ["b"]] } };
      expect(await mix(schema, {}, data)).toEqual(data);
    });
    it("retains matrix rank through the extraction completion producer pipeline", async () => {
      const schema = {
        type: "object",
        properties: {
          matrix: {
            type: "array",
            items: { type: "array", items: { type: "number" } },
          },
        },
      };
      const completions = [{ matrix: [[1, 2]] }, { matrix: [[3, 4]] }];
      const validate = new Ajv().compile(schema);
      expect(completions.every(completion => validate(completion))).toBe(true);
      const transformed = transform(schema, completions);
      expect(transformed).toEqual({
        matrix: [
          [1, 2],
          [3, 4],
        ],
      });
      const result = await mix(
        schema,
        {},
        merge(deduplicateForSchema(transformed, schema)),
      );
      expect(validate(result)).toBe(true);
      expect(result).toEqual({
        matrix: [
          [1, 2],
          [3, 4],
        ],
      });
    });
    for (const uniqueItems of [false, true]) {
      it(`preserves repeated matrix rows according to uniqueItems=${uniqueItems}`, async () => {
        const schema = {
          type: "object",
          properties: {
            matrix: {
              type: "array",
              uniqueItems,
              items: { type: "array", items: { type: "number" } },
            },
          },
        };
        const transformed = transform(schema, [
          {
            matrix: [
              [1, 2],
              [1, 2],
            ],
          },
        ]);
        const expected = {
          matrix: uniqueItems
            ? [[1, 2]]
            : [
                [1, 2],
                [1, 2],
              ],
        };
        expect(transformed).toEqual(expected);
        const result = await mix(
          schema,
          {},
          merge(deduplicateForSchema(transformed, schema)),
        );
        expect(result).toEqual(expected);
        expect(new Ajv().compile(schema)(result)).toBe(true);
      });
    }
    for (const items of [
      [{ type: "array", items: { type: "number" } }],
      { items: { type: "number" } },
      { type: ["array", "null"], items: { type: "number" } },
    ]) {
      it(`preserves non-plain matrix item declarations ${JSON.stringify(items)}`, async () => {
        const schema = {
          type: "object",
          properties: { matrix: { type: "array", items } },
        };
        const data = {
          matrix: [
            [1, 2],
            [3, 4],
          ],
        };
        expect(await mix(schema, {}, data)).toEqual(data);
      });
    }
    for (const [itemSchema, values] of [
      [{ type: "string" }, ["a", "b"]],
      [{ type: "string", items: { type: "number" } }, ["a", "b"]],
      [
        { type: "object", properties: { value: { type: "string" } } },
        [{ value: "a" }, { value: "b" }],
      ],
      [
        {
          type: "object",
          items: { type: "number" },
          properties: { value: { type: "string" } },
        },
        [{ value: "a" }, { value: "b" }],
      ],
      [
        { type: "array", items: { type: "number" } },
        [
          [1, 2],
          [3, 4],
        ],
      ],
    ] as const) {
      it(`derives rank from resolved local definitions for ${itemSchema.type} items`, async () => {
        const root = {
          type: "object",
          properties: {
            values: { type: "array", items: { $ref: "#/$defs/Item" } },
          },
          $defs: { Item: itemSchema },
        };
        // The real F0 extraction consumer dereferences before splitting and
        // transforming; the resulting item schema supplies the actual rank.
        const schema = await dereferenceSchema(root);
        const completions = [{ values: [values[0]] }, { values: [values[1]] }];
        const transformed = transform(schema, completions);
        const result = await mix(
          schema,
          {},
          merge(deduplicateForSchema(transformed, schema)),
        );
        expect(result).toEqual({ values });
        expect(new Ajv().compile(root)(result)).toBe(true);
        if (itemSchema.type !== "array") {
          expect(
            await mix(schema, {}, { values: [[values[0]], [values[1]]] }),
          ).toEqual({ values });
        }
      });
    }
    for (const [label, items] of [
      [
        "anyOf",
        {
          anyOf: [
            { type: "array", items: { type: "number" } },
            { type: "string" },
          ],
        },
      ],
      [
        "oneOf",
        {
          oneOf: [
            { type: "array", items: { type: "number" } },
            { type: "null" },
          ],
        },
      ],
      [
        "nested combinators",
        {
          anyOf: [
            {
              oneOf: [
                { type: "array", items: { type: "number" } },
                { type: "string" },
              ],
            },
            { type: "null" },
          ],
        },
      ],
      [
        "allOf",
        {
          allOf: [
            { type: "array", items: { type: "number" } },
            { minItems: 1 },
          ],
        },
      ],
      [
        "allOf with nested anyOf",
        {
          allOf: [
            {
              anyOf: [
                { type: "array", items: { type: "number" } },
                { type: "null" },
              ],
            },
            { minItems: 1 },
          ],
        },
      ],
      [
        "tuple allOf",
        [
          {
            allOf: [
              { type: "array", items: { type: "number" } },
              { minItems: 1 },
            ],
          },
        ],
      ],
      [
        "tuple combinators",
        [
          {
            anyOf: [
              { type: "array", items: { type: "number" } },
              { type: "string" },
            ],
          },
        ],
      ],
    ] as const) {
      it(`preserves matrix rows through valid ${label} item combinators`, async () => {
        const schema = {
          type: "object",
          properties: { matrix: { type: "array", items } },
        };
        const completions = [
          {
            matrix: [
              [1, 2],
              [1, 2],
            ],
          },
          { matrix: [[3, 4]] },
        ];
        const validate = new Ajv({ strictTuples: false }).compile(schema);
        expect(completions.every(completion => validate(completion))).toBe(
          true,
        );
        const expected = {
          matrix: [
            [1, 2],
            [1, 2],
            [3, 4],
          ],
        };
        expect(await mix(schema, {}, expected)).toEqual(expected);
        const transformed = transform(schema, completions);
        const result = await mix(
          schema,
          {},
          merge(deduplicateForSchema(transformed, schema)),
        );
        expect(validate(result)).toBe(true);
        expect(result).toEqual(expected);
      });
    }
    for (const items of [
      { allOf: [{ type: "string" }, { minLength: 1 }] },
      {
        allOf: [
          {
            anyOf: [
              { type: "array", items: { type: "number" } },
              { type: "string" },
            ],
          },
          { type: "string" },
        ],
      },
      { anyOf: [{ type: "string" }, { type: "null" }] },
      { oneOf: [{ type: "string" }, { type: "null" }] },
      {
        type: "string",
        anyOf: [
          { type: "array", items: { type: "number" } },
          { type: "string" },
        ],
      },
      {
        type: "string",
        oneOf: [
          { type: "array", items: { type: "number" } },
          { type: "string" },
        ],
      },
    ]) {
      it(`flattens scalar wrappers with non-array or type-constrained combinators ${JSON.stringify(items)}`, async () => {
        const schema = {
          type: "object",
          properties: { values: { type: "array", items } },
        };
        const expected = { values: ["a", "b"] };
        expect(new Ajv().compile(schema)(expected)).toBe(true);
        expect(await mix(schema, {}, { values: [["a"], ["b"]] })).toEqual(
          expected,
        );
      });
    }
    for (const [label, constraint, values] of [
      ["scalar const", { const: "a" }, ["a", "a"]],
      ["scalar enum", { enum: ["a", "b"] }, ["a", "b"]],
      ["null const", { const: null }, [null, null]],
      ["object enum", { enum: [{ id: 1 }, { id: 2 }] }, [{ id: 1 }, { id: 2 }]],
    ] as const) {
      it(`flattens valid scalar wrappers narrowed by allOf ${label}`, async () => {
        const schema = {
          type: "object",
          properties: {
            values: {
              type: "array",
              items: {
                allOf: [{ anyOf: [{ type: "array" }, {}] }, constraint],
              },
            },
          },
        };
        const expected = { values };
        const validate = new Ajv().compile(schema);
        expect(validate(expected)).toBe(true);
        const wrapped = { values: values.map(value => [value]) };
        expect(validate(wrapped)).toBe(false);
        const result = await mix(schema, {}, wrapped);
        expect(result).toEqual(expected);
        expect(validate(result)).toBe(true);
      });
    }
    for (const [label, constraint, values] of [
      [
        "array const",
        { const: [1, 2] },
        [
          [1, 2],
          [1, 2],
        ],
      ],
      [
        "array enum",
        {
          enum: [
            [1, 2],
            [3, 4],
          ],
        },
        [
          [1, 2],
          [3, 4],
        ],
      ],
      ["mixed enum", { enum: [[1, 2], "a"] }, [[1, 2], "a"]],
    ] as const) {
      for (const intersected of [false, true]) {
        it(`preserves valid ${label} rank ${intersected ? "inside allOf" : "directly"}`, async () => {
          const schema = {
            type: "object",
            properties: {
              values: {
                type: "array",
                items: intersected ? { allOf: [constraint, {}] } : constraint,
              },
            },
          };
          const completions = values.map(value => ({ values: [value] }));
          const expected = { values };
          const validate = new Ajv().compile(schema);
          expect(completions.every(completion => validate(completion))).toBe(
            true,
          );
          expect(await mix(schema, {}, expected)).toEqual(expected);
          const transformed = transform(schema, completions);
          const result = await mix(
            schema,
            {},
            merge(deduplicateForSchema(transformed, schema)),
          );
          expect(result).toEqual(expected);
          expect(validate(result)).toBe(true);
        });
      }
    }
    it("retains scalar rank through the same completion producer pipeline", async () => {
      const schema = {
        type: "object",
        properties: { values: { type: "array", items: { type: "number" } } },
      };
      const transformed = transform(schema, [{ values: [1] }, { values: [2] }]);
      expect(
        await mix(schema, {}, merge(deduplicateForSchema(transformed, schema))),
      ).toEqual({ values: [1, 2] });
    });
    it("continues flattening chunk wrappers for scalar-item arrays", async () => {
      const schema = {
        properties: { values: { type: "array", items: { type: "number" } } },
      };
      expect(await mix(schema, {}, { values: [[1], [2]] })).toEqual({
        values: [1, 2],
      });
    });
  });
}
