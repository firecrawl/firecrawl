import { SourceTracker } from "../source-tracker";
import { transformArrayToObject } from "../transform-array-to-obj";

describe("SourceTracker", () => {
  let sourceTracker: SourceTracker;

  beforeEach(() => {
    sourceTracker = new SourceTracker();
  });

  describe("transformResults", () => {
    it("should transform and merge results while preserving sources", () => {
      const extractionResults = [
        {
          extract: { products: [{ name: "Product 1", price: 10 }] },
          url: "http://example1.com",
        },
        {
          extract: { products: [{ name: "Product 2", price: 20 }] },
          url: "http://example2.com",
        },
      ];

      const schema = {
        type: "object",
        properties: {
          products: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: "number" },
              },
            },
          },
        },
      };

      const result = sourceTracker.transformResults(extractionResults, schema);
      expect(result).toEqual({
        products: [
          { name: "Product 1", price: 10 },
          { name: "Product 2", price: 20 },
        ],
      });
    });

    it("should match original transformArrayToObject behavior", () => {
      // Test case 1: Simple array transformation
      const schema1 = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
              },
            },
          },
        },
      };

      const extractionResults1 = [
        { extract: { items: [{ id: 1 }] }, url: "url1" },
        { extract: { items: [{ id: 2 }] }, url: "url2" },
      ];

      const originalResult1 = transformArrayToObject(
        schema1,
        extractionResults1.map(r => r.extract),
      );
      const newResult1 = sourceTracker.transformResults(
        extractionResults1,
        schema1,
      );
      expect(newResult1).toEqual(originalResult1);

      // Test case 2: Nested objects with arrays
      const schema2 = {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              products: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "number" },
                    variants: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      };

      const extractionResults2 = [
        {
          extract: {
            data: {
              products: [{ id: 1, variants: ["a", "b"] }],
            },
          },
          url: "url1",
        },
        {
          extract: {
            data: {
              products: [{ id: 2, variants: ["c", "d"] }],
            },
          },
          url: "url2",
        },
      ];

      const originalResult2 = transformArrayToObject(
        schema2,
        extractionResults2.map(r => r.extract),
      );
      const newResult2 = sourceTracker.transformResults(
        extractionResults2,
        schema2,
      );
      expect(newResult2).toEqual(originalResult2);

      // Test case 3: Empty arrays
      const emptyResults = [];
      const originalResult3 = transformArrayToObject(schema1, emptyResults);
      const newResult3 = sourceTracker.transformResults([], schema1);
      expect(newResult3).toEqual(originalResult3);

      // Test case 4: Non-array properties
      const schema4 = {
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "number" },
        },
      };

      const extractionResults4 = [
        { extract: { name: "test1", count: 1 }, url: "url1" },
        { extract: { name: "test2", count: 2 }, url: "url2" },
      ];

      const originalResult4 = transformArrayToObject(
        schema4,
        extractionResults4.map(r => r.extract),
      );
      const newResult4 = sourceTracker.transformResults(
        extractionResults4,
        schema4,
      );
      expect(newResult4).toEqual(originalResult4);
    });
  });

  describe("mapSourcesToFinalItems", () => {
    it("should correctly map sources after deduplication and merging", () => {
      // Setup initial data with mergeable items (same name, complementary fields)
      const extractionResults = [
        {
          extract: {
            products: [{ name: "Product 1", price: 10, description: null }],
          },
          url: "http://example1.com",
        },
        {
          extract: {
            products: [
              { name: "Product 1", price: null, description: "Great product" },
            ],
          },
          url: "http://example2.com",
        },
      ];

      const schema = {
        type: "object",
        properties: {
          products: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: "number" },
                description: { type: "string" },
              },
            },
          },
        },
      };

      // Transform results first
      const multiEntityResult = sourceTracker.transformResults(
        extractionResults,
        schema,
      );
      sourceTracker.trackPreDeduplicationSources(multiEntityResult);

      // Test source mapping with a merged item that matches both sources
      const sources = sourceTracker.mapSourcesToFinalItems(
        {
          products: [
            { name: "Product 1", price: 10, description: "Great product" },
          ],
        },
        ["products"],
      );

      expect(sources).toEqual({
        "products[0]": ["http://example1.com", "http://example2.com"],
      });
    });

    it("should handle empty results", () => {
      const sources = sourceTracker.mapSourcesToFinalItems({}, []);
      expect(sources).toEqual({});
    });

    it("should handle non-array properties", () => {
      const sources = sourceTracker.mapSourcesToFinalItems(
        { nonArray: "value" } as any,
        ["nonArray"],
      );
      expect(sources).toEqual({});
    });
  });

  describe("trackPreDeduplicationSources", () => {
    it("should track sources before deduplication", () => {
      const extractionResults = [
        {
          extract: { products: [{ id: 1, name: "Product 1" }] },
          url: "http://example1.com",
        },
        {
          extract: { products: [{ id: 1, name: "Product 1" }] },
          url: "http://example2.com",
        },
      ];

      const schema = {
        type: "object",
        properties: {
          products: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                name: { type: "string" },
              },
            },
          },
        },
      };

      const multiEntityResult = sourceTracker.transformResults(
        extractionResults,
        schema,
      );
      sourceTracker.trackPreDeduplicationSources(multiEntityResult);

      // Test source mapping after deduplication
      const sources = sourceTracker.mapSourcesToFinalItems(
        {
          products: [{ id: 1, name: "Product 1" }],
        },
        ["products"],
      );

      expect(sources).toEqual({
        "products[0]": ["http://example1.com", "http://example2.com"],
      });
    });
  });
});
