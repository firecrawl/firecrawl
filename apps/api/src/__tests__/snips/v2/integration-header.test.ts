import { config } from "../../../config";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  createTestIdUrl,
  describeIf,
} from "../lib";
import request, { idmux, Identity, scrapeTimeout, TEST_API_URL } from "./lib";
import { HAS_JOB_LOG, waitForJobLogRow } from "../job-log";

const CAN_READ_LOG = !!config.USE_DB_AUTHENTICATION && HAS_JOB_LOG;

async function scrapeWithHeader(
  path: "/v1/scrape" | "/v2/scrape",
  body: Record<string, unknown>,
  identity: Identity,
  integrationHeader: string,
) {
  return await request(TEST_API_URL)
    .post(path)
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .set("User-Agent", "node")
    .set("X-Integration", integrationHeader)
    .send(body);
}

async function loggedIntegration(identity: Identity, url: string) {
  const row = await waitForJobLogRow<{ integration: string | null }>(
    "requests",
    "team_id = {teamId: UUID} AND kind = 'scrape' AND target_hint = {url: String}",
    { teamId: identity.teamId, url },
  );
  expect(row).not.toBeNull();
  return row!.integration;
}

describeIf(ALLOW_TEST_SUITE_WEBSITE)("X-Integration header", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "integration-header",
      concurrency: 100,
      credits: 1000000,
    });
  }, 10000);

  concurrentIf(CAN_READ_LOG).each(["/v1/scrape", "/v2/scrape"] as const)(
    "attributes %s to a header-only integration",
    async path => {
      const url = createTestIdUrl();
      const res = await scrapeWithHeader(path, { url }, identity, " N8N ");

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(await loggedIntegration(identity, url)).toBe("n8n");
    },
    scrapeTimeout + 60000,
  );

  concurrentIf(CAN_READ_LOG)(
    "prefers the body integration over the header",
    async () => {
      const url = createTestIdUrl();
      const res = await scrapeWithHeader(
        "/v2/scrape",
        { url, integration: "_integration_header_test" },
        identity,
        "n8n",
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(await loggedIntegration(identity, url)).toBe(
        "_integration_header_test",
      );
    },
    scrapeTimeout + 60000,
  );

  concurrentIf(CAN_READ_LOG)(
    "lets a valid header override a body integration of cli",
    async () => {
      const url = createTestIdUrl();
      const res = await scrapeWithHeader(
        "/v2/scrape",
        { url, integration: "cli" },
        identity,
        "hermes",
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(await loggedIntegration(identity, url)).toBe("hermes");
    },
    scrapeTimeout + 60000,
  );

  it.concurrent(
    "keeps a body integration of cli when the header is invalid",
    async () => {
      const url = createTestIdUrl();
      const res = await scrapeWithHeader(
        "/v2/scrape",
        { url, integration: "cli" },
        identity,
        "not a valid tag!",
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      if (!CAN_READ_LOG) return;
      expect(await loggedIntegration(identity, url)).toBe("cli");
    },
    scrapeTimeout + 60000,
  );

  it.concurrent(
    "ignores an invalid header and still succeeds",
    async () => {
      const url = createTestIdUrl();
      const res = await scrapeWithHeader(
        "/v2/scrape",
        { url },
        identity,
        "not-a-real-integration",
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      if (!CAN_READ_LOG) return;
      expect(await loggedIntegration(identity, url)).toBeNull();
    },
    scrapeTimeout + 60000,
  );
});
