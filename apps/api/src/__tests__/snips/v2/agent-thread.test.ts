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

// A thread turn drives a browser and a model, so the cases that run one need
// fire-engine and AI. AGENTS.md gates fire-engine tests on
// !TEST_SUITE_SELF_HOSTED, and AI tests on !TEST_SUITE_SELF_HOSTED ||
// OPENAI_API_KEY || OLLAMA_BASE_URL. Every case that touches a thread also
// reaches the agent beta service, so that URL must be configured too.
const REQUIRES_FIRE_ENGINE = TEST_PRODUCTION;
const REQUIRES_AI = TEST_PRODUCTION || HAS_AI;
const HAS_AGENT_BETA = !!config.EXTRACT_V3_BETA_URL;

// A turn has to reach a terminal status before the next one is accepted, which
// takes several scrape budgets rather than one.
const TURN_TIMEOUT = scrapeTimeout * 6;

let identity: Identity;
let otherIdentity: Identity;

beforeAll(async () => {
  [identity, otherIdentity] = await Promise.all([
    idmux({ name: "agent-thread", credits: 1000000 }),
    idmux({ name: "agent-thread-other", credits: 1000000 }),
  ]);
}, scrapeTimeout);

const agentRaw = (body: Record<string, unknown>, apiKey?: string) =>
  request(TEST_API_URL)
    .post("/v2/agent")
    .set("Authorization", `Bearer ${apiKey ?? identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);

const statusOf = (jobId: string, apiKey?: string) =>
  request(TEST_API_URL)
    .get(`/v2/agent/${jobId}`)
    .set("Authorization", `Bearer ${apiKey ?? identity.apiKey}`);

const traceOf = (jobId: string) =>
  request(TEST_API_URL)
    .get(`/v2/agent/${jobId}/trace`)
    .set("Authorization", `Bearer ${identity.apiKey}`);

const threadOf = (
  threadId: string,
  options: { apiKey?: string; includeData?: boolean } = {},
) =>
  request(TEST_API_URL)
    .get(
      `/v2/agent/threads/${threadId}` +
        (options.includeData ? "?includeData=true" : ""),
    )
    .set("Authorization", `Bearer ${options.apiKey ?? identity.apiKey}`);

const cancel = (jobId: string) =>
  request(TEST_API_URL)
    .delete(`/v2/agent/${jobId}`)
    .set("Authorization", `Bearer ${identity.apiKey}`);

const listAgentIds = async () => {
  const response = await request(TEST_API_URL)
    .get("/v2/agent")
    .set("Authorization", `Bearer ${identity.apiKey}`);

  expect(response.statusCode).toBe(200);
  return ((response.body.agents ?? []) as { id: string }[]).map(a => a.id);
};

async function waitForTerminal(jobId: string) {
  const deadline = Date.now() + TURN_TIMEOUT - scrapeTimeout;

  while (Date.now() < deadline) {
    const status = await statusOf(jobId);
    expect(status.statusCode).toBe(200);
    if (status.body.status !== "processing") return status.body;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error(`Agent run ${jobId} did not reach a terminal status`);
}

async function startTurn(body: Record<string, unknown>) {
  const response = await agentRaw(body);

  if (response.statusCode !== 200) {
    console.warn(
      "Agent thread turn did not start",
      JSON.stringify(response.body, null, 2),
    );
  }

  expect(response.statusCode).toBe(200);
  expect(response.body.success).toBe(true);
  expect(typeof response.body.id).toBe("string");
  expect(typeof response.body.threadId).toBe("string");
  return response.body as { id: string; threadId: string; threadTurn?: number };
}

// agentRequestSchema.parse runs at the top of agentController, before the
// controller touches the agent service, a browser or a model, so these cases
// run everywhere instead of skipping with the live turns below.
describe("Agent thread parameter validation", () => {
  it(
    "rejects a threadId that is not a UUID",
    async () => {
      const response = await agentRaw({
        urls: [TEST_SUITE_WEBSITE],
        prompt: "What does this page offer?",
        threadId: "not-a-uuid",
      });

      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
    },
    scrapeTimeout,
  );

  it(
    "rejects an unknown mode",
    async () => {
      const response = await agentRaw({
        urls: [TEST_SUITE_WEBSITE],
        prompt: "What does this page offer?",
        mode: "argue",
      });

      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});

describeIf(HAS_AGENT_BETA)("Agent thread rejections", () => {
  it(
    "rejects an unknown threadId without creating a request",
    async () => {
      const before = await listAgentIds();

      const response = await agentRaw({
        urls: [TEST_SUITE_WEBSITE],
        prompt: "What does this page offer?",
        threadId: crypto.randomUUID(),
      });

      expect(response.statusCode).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("thread_not_found");

      expect(await listAgentIds()).toEqual(before);
    },
    scrapeTimeout,
  );

  it(
    "reports an unknown thread as not found",
    async () => {
      const response = await threadOf(crypto.randomUUID());

      expect(response.statusCode).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("thread_not_found");
    },
    scrapeTimeout,
  );
});

describeIf(REQUIRES_FIRE_ENGINE && REQUIRES_AI && HAS_AGENT_BETA)(
  "Agent threads",
  () => {
    it(
      "continues an extract thread across two turns",
      async () => {
        const first = await startTurn({
          urls: [TEST_SUITE_WEBSITE],
          prompt: "Extract the page title.",
          effort: "low",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        });

        expect(first.threadTurn).toBe(1);
        const firstStatus = await waitForTerminal(first.id);
        expect(firstStatus.status).toBe("completed");
        expect(firstStatus.threadId).toBe(first.threadId);

        const second = await startTurn({
          threadId: first.threadId,
          prompt: "Add the page's main heading as `heading`.",
          effort: "low",
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              heading: { type: "string" },
            },
            required: ["title", "heading"],
          },
        });

        expect(second.threadId).toBe(first.threadId);
        expect(second.threadTurn).toBe(2);

        const secondStatus = await waitForTerminal(second.id);
        expect(secondStatus.status).toBe("completed");
        expect(secondStatus.threadTurn).toBe(2);
        expect(Object.keys(secondStatus.data)).toEqual(
          expect.arrayContaining(["title", "heading"]),
        );

        const thread = await threadOf(first.threadId, { includeData: true });
        expect(thread.statusCode).toBe(200);
        expect(thread.body.success).toBe(true);
        expect(thread.body.thread.id).toBe(first.threadId);
        expect(thread.body.thread.runs).toHaveLength(2);
        expect(
          thread.body.thread.runs.map((run: { status: string }) => run.status),
        ).toEqual(["succeeded", "succeeded"]);
        expect(
          thread.body.thread.runs.map((run: { turn: number }) => run.turn),
        ).toEqual([1, 2]);
      },
      TURN_TIMEOUT * 2,
    );

    it(
      "answers a chat-mode follow-up with a message instead of data",
      async () => {
        const first = await startTurn({
          urls: [TEST_SUITE_WEBSITE],
          prompt: "Read this page and note what it offers.",
          mode: "chat",
          effort: "low",
        });

        await waitForTerminal(first.id);

        const second = await startTurn({
          threadId: first.threadId,
          prompt: "In one sentence, what is that page about?",
        });

        const secondStatus = await waitForTerminal(second.id);
        expect(secondStatus.status).toBe("completed");
        expect(secondStatus.mode).toBe("chat");
        expect(typeof secondStatus.message).toBe("string");
        expect(secondStatus.message.length).toBeGreaterThan(0);
        expect(secondStatus.data).toBeNull();

        const trace = await traceOf(second.id);
        expect(trace.statusCode).toBe(200);
        expect(
          (trace.body.events as { type: string }[]).some(
            event => event.type === "assistant.message",
          ),
        ).toBe(true);
      },
      TURN_TIMEOUT * 2,
    );

    it(
      "rejects a follow-up while the thread is busy",
      async () => {
        const first = await startTurn({
          urls: [TEST_SUITE_WEBSITE],
          prompt: "Extract the page title.",
          effort: "low",
        });

        const busy = await agentRaw({
          threadId: first.threadId,
          prompt: "And the heading?",
        });

        expect(busy.statusCode).toBe(409);
        expect(busy.body.success).toBe(false);
        expect(busy.body.code).toBe("thread_busy");
        expect(busy.body.runId).toBe(first.id);

        await cancel(first.id);
        await waitForTerminal(first.id);

        const second = await agentRaw({
          threadId: first.threadId,
          prompt: "And the heading?",
          effort: "low",
        });

        expect(second.statusCode).toBe(200);
        expect(second.body.threadId).toBe(first.threadId);

        await cancel(second.body.id);
      },
      TURN_TIMEOUT * 2,
    );

    it(
      "hides a thread from another team",
      async () => {
        const first = await startTurn({
          urls: [TEST_SUITE_WEBSITE],
          prompt: "Extract the page title.",
          effort: "low",
        });

        await cancel(first.id);
        await waitForTerminal(first.id);

        const crossTeamTurn = await agentRaw(
          {
            threadId: first.threadId,
            prompt: "And the heading?",
          },
          otherIdentity.apiKey,
        );

        expect(crossTeamTurn.statusCode).toBe(404);
        expect(crossTeamTurn.body.code).toBe("thread_not_found");

        const crossTeamRead = await threadOf(first.threadId, {
          apiKey: otherIdentity.apiKey,
        });

        expect(crossTeamRead.statusCode).toBe(404);
        expect(crossTeamRead.body.code).toBe("thread_not_found");
      },
      TURN_TIMEOUT * 2,
    );

    it(
      "keeps the plain start and status shapes intact",
      async () => {
        const response = await agentRaw({
          urls: [TEST_SUITE_WEBSITE],
          prompt: "What does this page offer?",
          effort: "low",
        });

        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);
        expect(typeof response.body.id).toBe("string");
        // The start response may only have grown by the thread fields.
        expect(
          Object.keys(response.body).filter(
            key => !["success", "id", "threadId", "threadTurn"].includes(key),
          ),
        ).toEqual([]);

        const status = await statusOf(response.body.id);
        expect(status.statusCode).toBe(200);
        expect(status.body.model).toBe("spark-2");
        expect(status.body.threadId).toBe(response.body.threadId);
        expect(status.body.message).toBeUndefined();

        await cancel(response.body.id);
      },
      scrapeTimeout,
    );
  },
);
