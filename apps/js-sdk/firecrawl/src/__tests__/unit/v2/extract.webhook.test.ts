import { describe, test, expect } from "@jest/globals";

import { startExtract } from "../../../v2/methods/extract";
import type { WebhookConfig } from "../../../v2/types";

describe("v2 extract webhook args", () => {
  test("startExtract args accept webhook string", () => {
    const args: Parameters<typeof startExtract>[1] = {
      urls: ["https://example.com"],
      prompt: "extract content",
      webhook: "https://example.com/webhook",
    };

    expect(args.webhook).toBe("https://example.com/webhook");
  });

  test("startExtract args accept webhook config", () => {
    const webhook: WebhookConfig = {
      url: "https://example.com/webhook",
      headers: { Authorization: "Bearer test" },
      events: ["completed", "failed"],
      metadata: { source: "unit-test" },
    };

    const args: Parameters<typeof startExtract>[1] = {
      urls: ["https://example.com"],
      prompt: "extract content",
      webhook,
    };

    expect(typeof args.webhook).toBe("object");
    expect((args.webhook as WebhookConfig).url).toBe("https://example.com/webhook");
  });
});
