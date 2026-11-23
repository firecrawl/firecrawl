import { vi } from "vitest";

vi.mock("../transformers/llmExtract", () => ({
  generateCompletions: vi.fn(),
  generateSchemaFromPrompt: vi.fn(),
}));

vi.mock("./promptInjectionGuard", () => ({
  checkForPromptInjection: vi.fn(async () => true),
  createPromptInjectionGuardLimiter: vi.fn(),
}));

import type { Mock } from "vitest";
import { extractData, schemaAsSent } from "./jsonExtract";
import { generateCompletions } from "../transformers/llmExtract";
import { checkForPromptInjection } from "./promptInjectionGuard";
import { JsonExtractionContentTooLargeError } from "../error";
import { CostTracking } from "../../../lib/cost-tracking";

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as any;

describe("extractData", () => {
  it("rejects markdown over the size cap before any extraction call", async () => {
    const markdown = "x".repeat(2_100_000);

    await expect(
      extractData({
        extractOptions: {
          logger: noopLogger,
          options: { schema: { type: "object", properties: {} } },
          markdown,
          costTrackingOptions: {
            costTracking: new CostTracking(),
            metadata: {},
          },
          metadata: { teamId: "test-team" },
        } as any,
        metadata: { teamId: "test-team" },
      }),
    ).rejects.toBeInstanceOf(JsonExtractionContentTooLargeError);
  });

  describe("prompt injection guard", () => {
    it("leaves the page itself to the scrape-level guard", async () => {
      (checkForPromptInjection as Mock).mockClear();
      (generateCompletions as Mock).mockResolvedValueOnce({
        extract: { ok: true },
        warning: undefined,
        totalUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });

      await extractData({
        extractOptions: {
          logger: noopLogger,
          options: { schema: { type: "object", properties: {} } },
          markdown: "page",
          costTrackingOptions: {
            costTracking: new CostTracking(),
            metadata: {},
          },
          metadata: { teamId: "test-team" },
        } as any,
        scrapeId: "test-scrape",
        metadata: { teamId: "test-team" },
      });

      expect(checkForPromptInjection).not.toHaveBeenCalled();
    });
  });

  describe("schema handling", () => {
    function run(schema: any) {
      return extractData({
        extractOptions: {
          logger: noopLogger,
          options: { schema },
          markdown: "page",
          costTrackingOptions: {
            costTracking: new CostTracking(),
            metadata: {},
          },
          metadata: { teamId: "test-team" },
        } as any,
        metadata: { teamId: "test-team" },
      });
    }

    function sentSchema() {
      const calls = (generateCompletions as Mock).mock.calls;
      return calls[calls.length - 1][0].options.schema;
    }

    function mockExtract(extract: any) {
      (generateCompletions as Mock).mockResolvedValueOnce({
        extract,
        warning: undefined,
        totalUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
    }

    it("sends the user's schema as-is", async () => {
      const schema = {
        judgments: { type: "array", items: { type: "string" } },
      };
      mockExtract({ judgments: ["a"] });

      const result = await run(schema);

      expect(sentSchema()).toEqual(schema);
      expect(result.extractedDataArray).toEqual([{ judgments: ["a"] }]);
    });

    it("extracts without a schema when none was given", async () => {
      mockExtract({ anything: 1 });

      const result = await run(undefined);

      expect(sentSchema()).toBeUndefined();
      expect(result.extractedDataArray).toEqual([{ anything: 1 }]);
    });

    it("returns root array results as the array itself", async () => {
      mockExtract({ items: [{ name: "a" }, { name: "b" }] });

      const result = await run({
        type: "Array",
        items: { type: "object", properties: { name: { type: "string" } } },
      });

      expect(result.extractedDataArray).toEqual([
        [{ name: "a" }, { name: "b" }],
      ]);
    });
  });
});

describe("schemaAsSent", () => {
  const bookWithDefs = {
    type: "object",
    properties: {
      title: { type: "string" },
      price: { $ref: "#/$defs/Money" },
    },
    required: ["title", "price"],
    additionalProperties: false,
    $defs: {
      Money: {
        type: "object",
        properties: {
          amount: { type: "number" },
          currency: { type: "string" },
        },
        required: ["amount", "currency"],
        additionalProperties: false,
      },
    },
  };

  const bookInlined = {
    type: "object",
    properties: {
      title: { type: "string" },
      price: {
        type: "object",
        properties: {
          amount: { type: "number" },
          currency: { type: "string" },
        },
        required: ["amount", "currency"],
        additionalProperties: false,
      },
    },
    required: ["title", "price"],
    additionalProperties: false,
  };

  const recursiveComments = {
    type: "object",
    properties: {
      body: { type: "string" },
      replies: { type: "array", items: { $ref: "#/$defs/Comment" } },
    },
    required: ["body"],
    $defs: {
      Comment: {
        type: "object",
        properties: {
          body: { type: "string" },
          replies: { type: "array", items: { $ref: "#/$defs/Comment" } },
        },
        required: ["body"],
      },
    },
  };

  it("inlines resolvable refs and drops $defs", () => {
    const sent = schemaAsSent(bookWithDefs, noopLogger);

    expect(JSON.stringify(sent)).not.toContain("$defs");
    expect(JSON.stringify(sent)).not.toContain("$ref");
    expect(sent).toEqual(bookInlined);
  });

  it("preserves a recursive schema whose $ref survives inlining", () => {
    const before = JSON.stringify(recursiveComments);
    const sent = schemaAsSent(recursiveComments, noopLogger);

    expect(JSON.stringify(sent)).toContain('"$ref"');
    expect(JSON.stringify(sent)).toBe(before);
  });

  it("returns a schema without refs deep-equal to itself", () => {
    expect(schemaAsSent(bookInlined, noopLogger)).toEqual(bookInlined);
  });

  it("drops unused $defs even when no property references them", () => {
    const sent = schemaAsSent(
      { ...bookInlined, $defs: { Money: bookInlined.properties.price } },
      noopLogger,
    );

    expect(sent.$defs).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain('"$ref"');
  });

  it("preserves legacy #/definitions refs it cannot resolve", () => {
    const legacy = {
      type: "object",
      properties: { price: { $ref: "#/definitions/Money" } },
      definitions: {
        Money: {
          type: "object",
          properties: { amount: { type: "number" } },
        },
      },
    };

    const sent = schemaAsSent(legacy, noopLogger);

    expect(JSON.stringify(sent)).toContain('"$ref"');
    expect(sent).toEqual(legacy);
  });

  it("preserves an acyclic ref chain that exceeds the resolver's depth limit", () => {
    const defs: Record<string, any> = {};
    const depth = 12;
    for (let i = 0; i < depth; i++) {
      defs[`L${i}`] =
        i === depth - 1 ? { type: "string" } : { $ref: `#/$defs/L${i + 1}` };
    }
    const chain = {
      type: "object",
      properties: { v: { $ref: "#/$defs/L0" } },
      $defs: defs,
    };

    const sent = schemaAsSent(chain, noopLogger);

    expect(JSON.stringify(sent)).toContain('"$ref"');
    expect(sent).toEqual(chain);
  });

  it("passes undefined through", () => {
    expect(schemaAsSent(undefined, noopLogger)).toBeUndefined();
  });
});
