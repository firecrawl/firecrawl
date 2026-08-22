import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  HAS_AI,
  testIf,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
import {
  scrape,
  scrapeRaw,
  creditUsage,
  scrapeTimeout,
  idmux,
  Identity,
} from "./lib";

const sleep = (ms: number) => new Promise(x => setTimeout(() => x(true), ms));
const sleepForBatchBilling = () => sleep(40000);

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "v1-json-extract-prompt-injection",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

const schema = {
  type: "object",
  properties: {
    title: { type: "string" },
  },
  required: ["title"],
};

describeIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
  "V1 JSON prompt-injection check",
  () => {
    it.concurrent(
      "does not change behavior or billing when checkPromptInjection is unset",
      async () => {
        const response = await scrape(
          {
            url: `${TEST_SUITE_WEBSITE}/product`,
            formats: ["json"],
            jsonOptions: { schema },
            timeout: scrapeTimeout,
          },
          identity,
        );

        expect(response.json).toBeDefined();
        expect(response.metadata.creditsUsed).toBe(5);
      },
      scrapeTimeout,
    );

    it.concurrent(
      "bills 9 credits and succeeds when checkPromptInjection is true and content is clean",
      async () => {
        const response = await scrape(
          {
            url: `${TEST_SUITE_WEBSITE}/product`,
            formats: ["json"],
            jsonOptions: { schema, checkPromptInjection: true },
            timeout: scrapeTimeout,
          },
          identity,
        );

        expect(response.json).toBeDefined();
        expect(response.metadata.creditsUsed).toBe(9);
      },
      scrapeTimeout,
    );

    it.concurrent(
      "blocks when checkPromptInjection is true and content contains a prompt injection",
      async () => {
        const response = await scrapeRaw(
          {
            url: `${TEST_SUITE_WEBSITE}/prompt-injection`,
            formats: ["json"],
            jsonOptions: { schema, checkPromptInjection: true },
            timeout: scrapeTimeout,
          },
          identity,
        );

        expect(response.statusCode).toBe(403);
        expect(response.body.success).toBe(false);
        expect(response.body.code).toBe("SCRAPE_PROMPT_INJECTION_DETECTED");
        expect(typeof response.body.error).toBe("string");
      },
      scrapeTimeout,
    );

    // Credit-delta assertions need real per-team isolation, which self-hosted
    // idmux doesn't provide (it falls back to one shared static identity) --
    // same reason billing.test.ts's whole suite is TEST_PRODUCTION-only.
    testIf(TEST_PRODUCTION)(
      "bills 5 credits when checkPromptInjection blocks a prompt injection",
      async () => {
        const blockedIdentity = await idmux({
          name: "v1-json-extract-prompt-injection/blocked",
          credits: 1000,
        });
        const rc1 = (await creditUsage(blockedIdentity)).remaining_credits;

        await scrapeRaw(
          {
            url: `${TEST_SUITE_WEBSITE}/prompt-injection`,
            formats: ["json"],
            jsonOptions: { schema, checkPromptInjection: true },
            timeout: scrapeTimeout,
          },
          blockedIdentity,
        );

        await sleepForBatchBilling();
        const rc2 = (await creditUsage(blockedIdentity)).remaining_credits;
        expect(rc1 - rc2).toBe(5);
      },
      scrapeTimeout + 40000,
    );
  },
);
