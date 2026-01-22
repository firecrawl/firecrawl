import { describeIf, HAS_AI, idmux, Identity, TEST_API_URL } from "../lib";
import request from "./lib";

const pollSleep = async (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "agent-max-credits-partial",
    concurrency: 10,
    credits: 100000,
  });
}, 10000);

describeIf(HAS_AI)("Agent max credits partial results", () => {
  it.concurrent(
    "returns partial data when max credits reached",
    async () => {
      const response = await request(TEST_API_URL)
        .post("/v2/agent")
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("Content-Type", "application/json")
        .send({
          prompt:
            "Find 20 AI startups with their websites and founders. Return as much as you can.",
          schema: {
            type: "object",
            properties: {
              companies: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    website: { type: "string" },
                    founders: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: ["name"],
                },
              },
            },
            required: ["companies"],
          },
          maxCredits: 200,
        });

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(typeof response.body.id).toBe("string");

      const jobId = response.body.id as string;
      const start = Date.now();
      let statusResponse: any = null;

      while (Date.now() - start < 120000) {
        statusResponse = await request(TEST_API_URL)
          .get(`/v2/agent/${encodeURIComponent(jobId)}`)
          .set("Authorization", `Bearer ${identity.apiKey}`)
          .send();

        if (statusResponse.body.status !== "processing") {
          break;
        }

        await pollSleep(500);
      }

      expect(statusResponse).not.toBeNull();
      expect(statusResponse?.statusCode).toBe(200);
      expect(statusResponse?.body.status).toBe("failed");
      expect(statusResponse?.body.error).toBe("Max credits limit reached");
      expect(statusResponse?.body.partial).toBeDefined();
    },
    120000,
  );
});
