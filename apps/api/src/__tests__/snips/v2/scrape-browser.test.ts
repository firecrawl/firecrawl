import crypto from "crypto";
import { config } from "../../../config";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  HAS_FIRE_ENGINE,
  TEST_PRODUCTION,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
  itIf,
} from "../lib";
import {
  Identity,
  idmux,
  scrapeStopInteractiveBrowserRaw,
  scrapeInteractRaw,
  scrapeRaw,
  scrapeTimeout,
} from "./lib";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function interactWithReplicaRetry(
  jobId: string,
  body: {
    code: string;
    language?: "python" | "node" | "bash";
    timeout?: number;
  },
  identity: Identity,
  attempts: number = 5,
) {
  let lastResponse: Awaited<ReturnType<typeof scrapeInteractRaw>> | null = null;

  for (let i = 0; i < attempts; i += 1) {
    const response = await scrapeInteractRaw(jobId, body, identity);
    lastResponse = response;
    if (response.statusCode !== 404) return response;
    await sleep(500);
  }

  return lastResponse!;
}

describe("Scrape browser interact replay", () => {
  let identity: Identity;
  let otherIdentity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "scrape-browser-replay",
      concurrency: 20,
      credits: 1_000_000,
    });
    otherIdentity = await idmux({
      name: "scrape-browser-replay-other",
      concurrency: 10,
      credits: 1_000_000,
    });
  }, 10000 + scrapeTimeout);

  const canRunReplayHappyPath =
    ALLOW_TEST_SUITE_WEBSITE &&
    !!config.BROWSER_SERVICE_URL &&
    (TEST_PRODUCTION || HAS_FIRE_ENGINE);

  itIf(canRunReplayHappyPath)(
    "replays scrape URL/waitFor/actions before interactive code runs",
    async () => {
      const marker = crypto.randomUUID();
      const url = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      let scrapeId: string | null = null;

      try {
        const scrapeResponse = await scrapeRaw(
          {
            url,
            origin: "website-replay-test",
            waitFor: 500,
            actions: [
              {
                type: "executeJavascript",
                script: `window.__firecrawlReplayMarker = "${marker}";`,
              },
            ],
          },
          identity,
        );

        expect(scrapeResponse.statusCode).toBe(200);
        expect(scrapeResponse.body.success).toBe(true);
        expect(typeof scrapeResponse.body.scrape_id).toBe("string");
        scrapeId = scrapeResponse.body.scrape_id as string;

        const executeResponse = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "node",
            timeout: 60,
            code: `
              const replayMarker = await page.evaluate(() => window.__firecrawlReplayMarker ?? null);
              console.log(replayMarker ?? "missing-marker");
            `,
          },
          identity,
        );

        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(true);
        expect(executeResponse.body.stdout).toContain(marker);
      } finally {
        if (scrapeId) {
          await scrapeStopInteractiveBrowserRaw(scrapeId, identity);
        }
      }
    },
    scrapeTimeout,
  );

  itIf(canRunReplayHappyPath)(
    "keeps a non-blank replay tab in the foreground for follow-up execs",
    async () => {
      const url = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      let scrapeId: string | null = null;

      try {
        const scrapeResponse = await scrapeRaw(
          {
            url,
            origin: "website-replay-test",
            actions: [
              {
                type: "executeJavascript",
                script: "window.open('about:blank', '_blank');",
              },
            ],
          },
          identity,
        );

        expect(scrapeResponse.statusCode).toBe(200);
        expect(scrapeResponse.body.success).toBe(true);
        expect(typeof scrapeResponse.body.scrape_id).toBe("string");
        scrapeId = scrapeResponse.body.scrape_id as string;

        const executeResponse = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "node",
            timeout: 60,
            code: `
              const visibleUrls = [];
              for (const candidate of page.context().pages()) {
                try {
                  const isVisible = await candidate.evaluate(
                    () => document.visibilityState === "visible",
                  );
                  if (isVisible) {
                    visibleUrls.push(candidate.url());
                  }
                } catch {}
              }

              const visibleNonBlankUrl =
                visibleUrls.find(value => value !== "about:blank") ?? "about:blank";
              console.log(visibleNonBlankUrl);
            `,
          },
          identity,
        );

        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(true);

        const visibleUrl =
          executeResponse.body.stdout
            ?.trim()
            .split("\n")
            .filter(Boolean)
            .pop() ?? "";

        expect(visibleUrl).not.toBe("about:blank");
        expect(visibleUrl).toContain(TEST_SUITE_WEBSITE);
      } finally {
        if (scrapeId) {
          await scrapeStopInteractiveBrowserRaw(scrapeId, identity);
        }
      }
    },
    scrapeTimeout,
  );

  itIf(canRunReplayHappyPath)(
    "interact with language=python succeeds on scrape-bound session (#3498)",
    async () => {
      const url = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      let scrapeId: string | null = null;

      try {
        const scrapeResponse = await scrapeRaw(
          {
            url,
            origin: "website-replay-test",
            waitFor: 500,
          },
          identity,
        );

        expect(scrapeResponse.statusCode).toBe(200);
        expect(scrapeResponse.body.success).toBe(true);
        expect(typeof scrapeResponse.body.scrape_id).toBe("string");
        scrapeId = scrapeResponse.body.scrape_id as string;

        // Run Python code that accesses the page — this previously failed
        // with TargetClosedError ~2/3 of the time because the Python
        // runtime's `page` var was never synced after the replay tab_sync.
        const executeResponse = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "python",
            timeout: 60,
            code: `title = await page.title()\nprint(title)`,
          },
          identity,
        );

        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(true);
        expect(executeResponse.body.exitCode).toBe(0);
        // stdout should contain the page title (non-empty string)
        expect(
          (executeResponse.body.stdout ?? "").trim().length,
        ).toBeGreaterThan(0);
      } finally {
        if (scrapeId) {
          await scrapeStopInteractiveBrowserRaw(scrapeId, identity);
        }
      }
    },
    scrapeTimeout,
  );

  itIf(canRunReplayHappyPath)(
    "interact with language=python can read replay marker on scrape-bound session",
    async () => {
      const marker = crypto.randomUUID();
      const url = `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`;
      let scrapeId: string | null = null;

      try {
        const scrapeResponse = await scrapeRaw(
          {
            url,
            origin: "website-replay-test",
            waitFor: 500,
            actions: [
              {
                type: "executeJavascript",
                script: `window.__firecrawlPyMarker = "${marker}";`,
              },
            ],
          },
          identity,
        );

        expect(scrapeResponse.statusCode).toBe(200);
        expect(scrapeResponse.body.success).toBe(true);
        expect(typeof scrapeResponse.body.scrape_id).toBe("string");
        scrapeId = scrapeResponse.body.scrape_id as string;

        // Verify Python can access the page and read the JS marker set
        // during the replay actions — proves page binding is correct.
        const executeResponse = await interactWithReplicaRetry(
          scrapeId,
          {
            language: "python",
            timeout: 60,
            code: [
              `marker = await page.evaluate("window.__firecrawlPyMarker || 'missing'")`,
              `print(marker)`,
            ].join("\n"),
          },
          identity,
        );

        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(true);
        expect(executeResponse.body.exitCode).toBe(0);
        expect(executeResponse.body.stdout).toContain(marker);
      } finally {
        if (scrapeId) {
          await scrapeStopInteractiveBrowserRaw(scrapeId, identity);
        }
      }
    },
    scrapeTimeout,
  );

  itIf(!TEST_SELF_HOST)(
    "returns 400 for invalid scrape job id format",
    async () => {
      const response = await scrapeInteractRaw(
        "not-a-valid-uuid",
        {
          code: "console.log('hi')",
          language: "node",
        },
        identity,
      );

      expect(response.statusCode).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe(
        "Invalid job ID format. Job ID must be a valid UUID.",
      );
    },
  );

  itIf(!TEST_SELF_HOST)(
    "returns 404 when scrape job does not exist",
    async () => {
      const response = await scrapeInteractRaw(
        crypto.randomUUID(),
        {
          code: "console.log('hi')",
          language: "node",
        },
        identity,
      );

      expect(response.statusCode).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Job not found.");
    },
  );

  itIf(ALLOW_TEST_SUITE_WEBSITE && !!config.IDMUX_URL)(
    "returns 403 when scrape job belongs to another team",
    async () => {
      const scrapeResponse = await scrapeRaw(
        {
          url: `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`,
          origin: "website-replay-test",
        },
        identity,
      );

      expect(scrapeResponse.statusCode).toBe(200);
      expect(scrapeResponse.body.success).toBe(true);
      expect(typeof scrapeResponse.body.scrape_id).toBe("string");

      const scrapeId = scrapeResponse.body.scrape_id as string;
      const executeResponse = await interactWithReplicaRetry(
        scrapeId,
        {
          code: "console.log('should fail')",
          language: "node",
        },
        otherIdentity,
      );

      expect(executeResponse.statusCode).toBe(403);
      expect(executeResponse.body.success).toBe(false);
      expect(executeResponse.body.error).toBe("Forbidden.");
    },
    scrapeTimeout,
  );

  itIf(ALLOW_TEST_SUITE_WEBSITE && !TEST_SELF_HOST)(
    "returns replay-context error when scrape data is not retained",
    async () => {
      const scrapeResponse = await scrapeRaw(
        {
          url: `${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}`,
          origin: "website-replay-test",
          zeroDataRetention: true,
        },
        identity,
      );

      expect(scrapeResponse.statusCode).toBe(200);
      expect(scrapeResponse.body.success).toBe(true);
      expect(typeof scrapeResponse.body.scrape_id).toBe("string");

      const scrapeId = scrapeResponse.body.scrape_id as string;
      const executeResponse = await interactWithReplicaRetry(
        scrapeId,
        {
          code: "console.log('should not run')",
          language: "node",
        },
        identity,
      );

      expect(executeResponse.statusCode).toBe(409);
      expect(executeResponse.body.success).toBe(false);
      expect(executeResponse.body.error).toContain(
        "Replay context is unavailable",
      );
    },
    scrapeTimeout,
  );
});
