import Firecrawl from "../../../index";
import { config } from "dotenv";
import { getIdentity, getApiUrl } from "./utils/idmux";
import { testTimeoutMs, withRateLimitRetry } from "./utils/rateLimit";
import { describe, test, expect, beforeAll } from "@jest/globals";

config();

const API_URL = getApiUrl();
let client: Firecrawl;

beforeAll(async () => {
  const { apiKey } = await getIdentity({ name: "js-e2e-parse" });
  client = withRateLimitRetry(new Firecrawl({ apiKey, apiUrl: API_URL }));
});

describe("v2.parse e2e", () => {
  test(
    "parses uploaded HTML files",
    async () => {
      if (!client) throw new Error();

      const doc = await client.parse(
        {
          data: `
            <!DOCTYPE html>
            <html>
              <body>
                <h1>JS SDK Parse E2E</h1>
                <p>multipart upload body</p>
              </body>
            </html>
          `,
          filename: "parse-e2e.html",
          contentType: "text/html",
        },
        {
          formats: ["markdown"],
        },
      );

      expect(doc.markdown).toContain("JS SDK Parse E2E");
      expect(doc.metadata?.creditsUsed).toBe(1);
    },
    testTimeoutMs(60_000),
  );

  test(
    "returns errors for unsupported file types",
    async () => {
      if (!client) throw new Error();

      await expect(
        client.parse(
          {
            data: Buffer.from("image-data"),
            filename: "parse-e2e.png",
            contentType: "image/png",
          },
          {
            formats: ["markdown"],
          },
        ),
      ).rejects.toThrow();
    },
    testTimeoutMs(60_000),
  );
});
