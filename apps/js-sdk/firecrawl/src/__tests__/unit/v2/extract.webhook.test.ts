import { describe, test, expect, jest } from "@jest/globals";

import { startExtract } from "../../../v2/methods/extract";
import type { ExtractResponse, WebhookConfig } from "../../../v2/types";

describe("v2 extract webhook args", () => {
  test("startExtract args accept webhook string", () => {
    const args: Parameters<typeof startExtract>[1] = {
      urls: ["https://example.com"],
      prompt: "extract content",
      webhook: "https://example.com/webhook",
    };

    expect(args.webhook).toBe("https://example.com/webhook");
  });

  test("startExtract forwards webhook string in payload", async () => {
    const post = jest.fn().mockResolvedValue({ status: 200, data: { id: "job_123" } as ExtractResponse });
    const http = { post } as any;

    await startExtract(http, {
      urls: ["https://example.com"],
      prompt: "extract content",
      webhook: "https://example.com/webhook",
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/v2/extract",
      expect.objectContaining({
        webhook: "https://example.com/webhook",
      })
    );
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

  test("startExtract forwards webhook config in payload", async () => {
    const webhook: WebhookConfig = {
      url: "https://example.com/webhook",
      headers: { Authorization: "Bearer test" },
      events: ["completed", "failed"],
    };

    const post = jest.fn().mockResolvedValue({ status: 200, data: { id: "job_456" } as ExtractResponse });
    const http = { post } as any;

    await startExtract(http, {
      urls: ["https://example.com"],
      prompt: "extract content",
      webhook,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/v2/extract",
      expect.objectContaining({
        webhook: expect.objectContaining({ url: "https://example.com/webhook" }),
      })
    );
  });
});
