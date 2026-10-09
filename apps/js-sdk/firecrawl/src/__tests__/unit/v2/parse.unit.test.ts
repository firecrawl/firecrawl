import { describe, test, expect } from "vitest";
import { FirecrawlClient } from "../../../v2/client";

describe("v2.parse unit", () => {
  test("rejects empty filenames before making requests", async () => {
    const client = new FirecrawlClient({
      apiKey: "test-key",
      apiUrl: "https://localhost:3002",
    });

    await expect(
      client.parse(
        {
          data: "<html><body>test</body></html>",
          filename: "   ",
          contentType: "text/html",
        },
        { formats: ["markdown"] },
      ),
    ).rejects.toThrow("filename cannot be empty");
  });

  test("rejects changeTracking format before making requests", async () => {
    const client = new FirecrawlClient({
      apiKey: "test-key",
      apiUrl: "https://localhost:3002",
    });

    await expect(
      client.parse(
        {
          data: "<html><body>test</body></html>",
          filename: "upload.html",
          contentType: "text/html",
        },
        { formats: ["markdown", { type: "changeTracking" } as any] },
      ),
    ).rejects.toThrow("parse does not support changeTracking format");
  });

  test("rejects video format before making requests", async () => {
    const client = new FirecrawlClient({
      apiKey: "test-key",
      apiUrl: "https://localhost:3002",
    });

    await expect(
      client.parse(
        {
          data: Buffer.from("<html></html>"),
          filename: "upload.html",
          contentType: "text/html",
        },
        { formats: ["video" as any] },
      ),
    ).rejects.toThrow("parse does not support video format");
  });

  test("rejects lockdown option before making requests", async () => {
    const client = new FirecrawlClient({
      apiKey: "test-key",
      apiUrl: "https://localhost:3002",
    });

    await expect(
      client.parse(
        {
          data: "<html><body>test</body></html>",
          filename: "upload.html",
          contentType: "text/html",
        },
        { formats: ["markdown"], lockdown: true } as any,
      ),
    ).rejects.toThrow("parse does not support cache/index options");
  });
});
