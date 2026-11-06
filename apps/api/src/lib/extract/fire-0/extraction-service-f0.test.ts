import { vi } from "vitest";

vi.mock("../../../controllers/auth", () => ({
  getACUCTeam: vi.fn(async () => null),
}));
vi.mock("../../threat-protection/request", () => ({
  resolveThreatProtection: vi.fn(async () => ({ policy: null })),
}));
vi.mock("../extract-redis", () => ({
  ExtractStep: {},
  updateExtract: vi.fn(async () => {}),
}));
vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn(async () => {}),
}));
vi.mock("../../../services/logging/log_job", () => ({
  logExtract: vi.fn(async () => {}),
}));
vi.mock("./url-processor-f0", () => ({
  processUrl_F0: vi.fn(async () => ["https://example.com/team"]),
  generateBasicCompletion_FO: vi.fn(),
}));
vi.mock("./document-scraper-f0", () => ({
  scrapeDocument_F0: vi.fn(async () => ({
    markdown: "Contact: alice@example.com, bob@example.com",
    metadata: {
      url: "https://example.com/team",
      sourceURL: "https://example.com/team",
      statusCode: 200,
    },
  })),
}));

const usage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
  model: "gpt-4o-mini",
};

vi.mock("./completions/analyzeSchemaAndPrompt-f0", () => ({
  analyzeSchemaAndPrompt_F0: vi.fn(async () => ({
    isMultiEntity: true,
    multiEntityKeys: ["emails"],
    reasoning: "a list of emails",
    keyIndicators: ["emails"],
    tokenUsage: usage,
  })),
}));
vi.mock("./completions/checkShouldExtract-f0", () => ({
  checkShouldExtract_F0: vi.fn(async () => ({
    extract: true,
    tokenUsage: usage,
  })),
}));
vi.mock("./completions/batchExtract-f0", () => ({
  batchExtractPromise_F0: vi.fn(async () => ({
    extract: { emails: ["alice@example.com", "bob@example.com"] },
    numTokens: 2,
    totalUsage: usage,
  })),
}));

import { extractRequestSchema } from "../../../controllers/v2/types";
import { performExtraction_F0 } from "./extraction-service-f0";

describe("performExtraction_F0", () => {
  it("extracts multi-entity keys whose schema uses a standard string format", async () => {
    const request = extractRequestSchema.parse({
      urls: ["https://example.com/team"],
      schema: {
        type: "object",
        properties: {
          emails: {
            type: "array",
            items: { type: "string", format: "email" },
          },
        },
        required: ["emails"],
      },
    });

    const result = await performExtraction_F0("extract-format-test", {
      request,
      teamId: "team-test",
      apiKeyId: null,
    });

    expect(result.success).toBe(true);
    expect(result.data.emails).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });
});
