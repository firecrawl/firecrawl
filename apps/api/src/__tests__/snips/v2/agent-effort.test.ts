import request from "supertest";
import { config } from "../../../config";
import {
  describeIf,
  HAS_AI,
  Identity,
  idmux,
  scrapeTimeout,
  TEST_API_URL,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";

// An accepted POST /v2/agent drives a browser and a model, so the cases that
// start a run need fire-engine and AI. AGENTS.md gates fire-engine tests on
// !TEST_SUITE_SELF_HOSTED, and AI tests on !TEST_SUITE_SELF_HOSTED ||
// OPENAI_API_KEY || OLLAMA_BASE_URL. Those cases also forward to the agent beta
// service, so that URL must be configured too.
const REQUIRES_FIRE_ENGINE = TEST_PRODUCTION;
const REQUIRES_AI = TEST_PRODUCTION || HAS_AI;
const HAS_AGENT_BETA = !!config.EXTRACT_V3_BETA_URL;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "agent-effort",
    credits: 1000000,
  });
}, scrapeTimeout);

const agentRaw = (body: Record<string, unknown>) =>
  request(TEST_API_URL)
    .post("/v2/agent")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);

// agentRequestSchema.parse runs at the top of agentController, before the
// controller touches the agent service, a browser or a model. A rejected
// request therefore needs only the API server and an authenticated team, so
// these cases run everywhere instead of skipping with the live runs below.
describe("Agent effort parameter validation", () => {
  it(
    "rejects model and effort together",
    async () => {
      const response = await agentRaw({
        urls: [TEST_SUITE_WEBSITE],
        prompt: "What does this page offer?",
        model: "spark-1-pro",
        effort: "low",
      });

      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("model");
      expect(response.body.error).toContain("effort");
    },
    scrapeTimeout,
  );

  it(
    "rejects an unknown effort level",
    async () => {
      const response = await agentRaw({
        urls: [TEST_SUITE_WEBSITE],
        prompt: "What does this page offer?",
        effort: "extreme",
      });

      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});

describeIf(REQUIRES_FIRE_ENGINE && REQUIRES_AI && HAS_AGENT_BETA)(
  "Agent effort parameter",
  () => {
    // Each accepted request starts a real run. Cancel it so the test does not
    // pay for work nobody reads.
    const cancel = (jobId: string) =>
      request(TEST_API_URL)
        .delete(`/v2/agent/${jobId}`)
        .set("Authorization", `Bearer ${identity.apiKey}`);

    const statusOf = (jobId: string) =>
      request(TEST_API_URL)
        .get(`/v2/agent/${jobId}`)
        .set("Authorization", `Bearer ${identity.apiKey}`);

    it(
      "accepts effort alone and runs spark-2",
      async () => {
        const response = await agentRaw({
          urls: [TEST_SUITE_WEBSITE],
          prompt: "What does this page offer?",
          effort: "low",
        });

        if (response.statusCode !== 200) {
          console.warn(
            "Agent request with effort did not succeed",
            JSON.stringify(response.body, null, 2),
          );
        }

        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);
        expect(typeof response.body.id).toBe("string");

        const status = await statusOf(response.body.id);
        expect(status.statusCode).toBe(200);
        expect(status.body.model).toBe("spark-2");

        await cancel(response.body.id);
      },
      scrapeTimeout,
    );

    it(
      "still keeps spark-1-pro when the caller sends neither field",
      async () => {
        const response = await agentRaw({
          urls: [TEST_SUITE_WEBSITE],
          prompt: "What does this page offer?",
        });

        if (response.statusCode !== 200) {
          console.warn(
            "Agent request without model or effort did not succeed",
            JSON.stringify(response.body, null, 2),
          );
        }

        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);
        expect(typeof response.body.id).toBe("string");

        const status = await statusOf(response.body.id);
        expect(status.statusCode).toBe(200);
        expect(status.body.model).toBe("spark-1-pro");

        await cancel(response.body.id);
      },
      scrapeTimeout,
    );
  },
);
