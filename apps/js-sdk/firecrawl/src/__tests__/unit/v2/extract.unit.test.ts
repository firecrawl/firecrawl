import { describe, expect, test } from "@jest/globals";
import { startExtract } from "../../../v2/methods/extract";
import type { WebhookConfig } from "../../../v2/types";

describe("v2.extract unit", () => {
  test("startExtract forwards string webhook in request payload", async () => {
    const post = jest.fn().mockResolvedValue({
      status: 200,
      data: { id: "extract-job" },
    });

    await startExtract({ post } as any, {
      urls: ["https://example.com"],
      prompt: "Extract title",
      webhook: "https://example.com/webhook",
    });

    expect(post).toHaveBeenCalledWith("/v2/extract", {
      urls: ["https://example.com"],
      prompt: "Extract title",
      webhook: "https://example.com/webhook",
    });
  });

  test("startExtract forwards object webhook in request payload", async () => {
    const post = jest.fn().mockResolvedValue({
      status: 200,
      data: { id: "extract-job" },
    });
    const webhook: WebhookConfig = {
      url: "https://example.com/webhook",
      headers: { "x-signature": "secret" },
    };

    await startExtract({ post } as any, {
      urls: ["https://example.com"],
      prompt: "Extract title",
      webhook,
    });

    expect(post).toHaveBeenCalledWith("/v2/extract", {
      urls: ["https://example.com"],
      prompt: "Extract title",
      webhook,
    });
  });
});
