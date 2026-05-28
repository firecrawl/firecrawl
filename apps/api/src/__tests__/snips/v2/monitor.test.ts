import {
  createTestIdUrl,
  describeIf,
  ALLOW_TEST_SUITE_WEBSITE,
  TEST_SELF_HOST,
} from "../lib";
import {
  idmux,
  Identity,
  monitorCheckRaw,
  monitorCreateRaw,
  monitorDeleteRaw,
  monitorEmailConfirmRaw,
  monitorEmailConfirmRawViaQuery,
  monitorEmailUnsubscribeRaw,
  monitorGetRaw,
  monitorListRaw,
  monitorPatchRaw,
  monitorRunRaw,
  scrapeTimeout,
} from "./lib";

describeIf(ALLOW_TEST_SUITE_WEBSITE && !TEST_SELF_HOST)("/v2/monitor", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "monitor",
      concurrency: 20,
      credits: 1000000,
    });
  }, 10000);

  it("creates, lists, gets, pauses, and deletes a monitor", async () => {
    const create = await monitorCreateRaw(
      {
        name: "snips monitor",
        schedule: { cron: "*/30 * * * *", timezone: "UTC" },
        targets: [
          {
            type: "scrape",
            urls: [createTestIdUrl(), createTestIdUrl()],
            scrapeOptions: { formats: ["markdown"] },
          },
        ],
        notification: { email: { enabled: false } },
      },
      identity,
    );

    expect(create.statusCode).toBe(200);
    expect(create.body.success).toBe(true);
    expect(create.body.data.id).toEqual(expect.any(String));
    expect(create.body.data.targets[0].id).toEqual(expect.any(String));

    const id = create.body.data.id;
    const list = await monitorListRaw(identity);
    expect(list.statusCode).toBe(200);
    expect(list.body.data.some((x: any) => x.id === id)).toBe(true);

    const get = await monitorGetRaw(id, identity);
    expect(get.statusCode).toBe(200);
    expect(get.body.data.id).toBe(id);

    const patch = await monitorPatchRaw(id, { status: "paused" }, identity);
    expect(patch.statusCode).toBe(200);
    expect(patch.body.data.status).toBe("paused");

    const del = await monitorDeleteRaw(id, identity);
    expect(del.statusCode).toBe(200);
    expect(del.body.success).toBe(true);
  });

  it("accepts an origin field in the create body", async () => {
    const create = await monitorCreateRaw(
      {
        name: "origin monitor",
        schedule: { cron: "*/30 * * * *", timezone: "UTC" },
        targets: [
          {
            type: "scrape",
            urls: [createTestIdUrl()],
          },
        ],
        origin: "python-sdk@4.28.0",
      },
      identity,
    );

    expect(create.statusCode).toBe(200);
    expect(create.body.success).toBe(true);
    const id = create.body.data.id;
    await monitorDeleteRaw(id, identity);
  });

  it("still rejects unknown keys in the create body", async () => {
    const create = await monitorCreateRaw(
      {
        name: "unknown key monitor",
        schedule: { cron: "*/30 * * * *", timezone: "UTC" },
        targets: [
          {
            type: "scrape",
            urls: [createTestIdUrl()],
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nonsenseField: "value",
      } as any,
      identity,
    );

    expect(create.statusCode).toBe(400);
    expect(create.body.success).toBe(false);
  });

  it("rejects cron schedules under 15 minutes", async () => {
    const response = await monitorCreateRaw(
      {
        name: "too frequent",
        schedule: { cron: "*/5 * * * *", timezone: "UTC" },
        targets: [
          {
            type: "scrape",
            urls: [createTestIdUrl()],
          },
        ],
      },
      identity,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain("15 minutes");
  });

  it(
    "runs a manual scrape monitor check",
    async () => {
      const create = await monitorCreateRaw(
        {
          name: "manual monitor",
          schedule: { cron: "*/30 * * * *", timezone: "UTC" },
          targets: [
            {
              type: "scrape",
              urls: [createTestIdUrl(), createTestIdUrl()],
              scrapeOptions: { formats: ["markdown"] },
            },
          ],
        },
        identity,
      );
      expect(create.statusCode).toBe(200);

      const monitorId = create.body.data.id;
      const run = await monitorRunRaw(monitorId, identity);
      expect(run.statusCode).toBe(200);
      const checkId = run.body.id;

      let check: any;
      for (let i = 0; i < 90; i++) {
        const raw = await monitorCheckRaw(monitorId, checkId, identity);
        expect(raw.statusCode).toBe(200);
        check = raw.body.data;
        if (["completed", "partial", "failed"].includes(check.status)) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      expect(["completed", "partial"]).toContain(check.status);
      expect(check.summary.totalPages).toBeGreaterThanOrEqual(2);
      expect(check.pages.length).toBeGreaterThanOrEqual(1);
      expect(check.next).toBeUndefined();

      const firstPage = await monitorCheckRaw(monitorId, checkId, identity, {
        limit: 1,
      });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.body.next).toContain("skip=1");
      expect(firstPage.body.next).toContain("limit=1");
      expect(firstPage.body.data.next).toBe(firstPage.body.next);
      expect(firstPage.body.data.pages).toHaveLength(1);

      await monitorDeleteRaw(monitorId, identity);
    },
    2 * scrapeTimeout,
  );

  it(
    "runs a JSON-mode monitor and surfaces a snapshot",
    async () => {
      const jsonSchema = {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: {
            type: "string",
            description: "The page title, verbatim.",
          },
        },
      };

      const create = await monitorCreateRaw(
        {
          name: "json-mode monitor",
          schedule: { cron: "*/30 * * * *", timezone: "UTC" },
          targets: [
            {
              type: "scrape",
              urls: [createTestIdUrl()],
              scrapeOptions: {
                formats: [
                  "markdown",
                  {
                    type: "json",
                    prompt: "Extract the page title verbatim.",
                    schema: jsonSchema,
                  },
                ],
              },
            },
          ],
        },
        identity,
      );
      expect(create.statusCode).toBe(200);

      const monitorId = create.body.data.id;
      const run = await monitorRunRaw(monitorId, identity);
      expect(run.statusCode).toBe(200);
      const checkId = run.body.id;

      let check: any;
      for (let i = 0; i < 90; i++) {
        const raw = await monitorCheckRaw(monitorId, checkId, identity);
        expect(raw.statusCode).toBe(200);
        check = raw.body.data;
        if (["completed", "partial", "failed"].includes(check.status)) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      expect(["completed", "partial"]).toContain(check.status);
      // First run: status is "new" (no previous scrape to diff against), no
      // snapshot persisted to GCS. We can't assert snapshot.json here
      // without a mutating fixture; a second run with a changed page would
      // be needed. The contract assertion is: when JSON mode is requested,
      // the monitor doesn't fall through the markdown path and crash.
      expect(check.pages[0].status).toBe("new");

      await monitorDeleteRaw(monitorId, identity);
    },
    2 * scrapeTimeout,
  );

  it(
    "accepts changeTracking-json format on a monitor target",
    async () => {
      const jsonSchema = {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", description: "The page title." },
        },
      };

      const create = await monitorCreateRaw(
        {
          name: "ct-json monitor",
          schedule: { cron: "*/30 * * * *", timezone: "UTC" },
          targets: [
            {
              type: "scrape",
              urls: [createTestIdUrl()],
              scrapeOptions: {
                formats: [
                  "markdown",
                  {
                    type: "changeTracking",
                    modes: ["json"],
                    prompt: "Extract the title.",
                    schema: jsonSchema,
                  },
                ],
              },
            },
          ],
        },
        identity,
      );
      expect(create.statusCode).toBe(200);

      const monitorId = create.body.data.id;
      const run = await monitorRunRaw(monitorId, identity);
      expect(run.statusCode).toBe(200);
      const checkId = run.body.id;

      let check: any;
      for (let i = 0; i < 90; i++) {
        const raw = await monitorCheckRaw(monitorId, checkId, identity);
        expect(raw.statusCode).toBe(200);
        check = raw.body.data;
        if (["completed", "partial", "failed"].includes(check.status)) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      expect(["completed", "partial"]).toContain(check.status);
      expect(check.pages[0].status).toBe("new");

      await monitorDeleteRaw(monitorId, identity);
    },
    2 * scrapeTimeout,
  );

  describe("email recipient opt-in", () => {
    function externalRecipient(): string {
      const id = Math.random().toString(36).slice(2, 10);
      return `optin-${id}@external-test.example`;
    }

    it("starts external recipients as pending without sending notifications", async () => {
      const recipient = externalRecipient();
      const create = await monitorCreateRaw(
        {
          name: "opt-in monitor",
          schedule: { cron: "*/30 * * * *", timezone: "UTC" },
          targets: [
            {
              type: "scrape",
              urls: [createTestIdUrl()],
              scrapeOptions: { formats: ["markdown"] },
            },
          ],
          notification: {
            email: { enabled: true, recipients: [recipient] },
          },
        },
        identity,
      );
      expect(create.statusCode).toBe(200);
      expect(create.body.data.emailRecipientSubscriptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            email: recipient.toLowerCase(),
            status: "pending",
            source: "opt_in",
          }),
        ]),
      );

      const get = await monitorGetRaw(create.body.data.id, identity);
      expect(get.body.data.emailRecipientSubscriptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            email: recipient.toLowerCase(),
            status: "pending",
          }),
        ]),
      );

      await monitorDeleteRaw(create.body.data.id, identity);
    });

    it("rejects malformed confirm/unsubscribe tokens with a 400 JSON error", async () => {
      const badConfirm = await monitorEmailConfirmRaw("x");
      expect(badConfirm.statusCode).toBe(400);
      expect(badConfirm.body).toEqual({
        success: false,
        error: "invalid_token",
      });

      const badUnsub = await monitorEmailUnsubscribeRaw("x");
      expect(badUnsub.statusCode).toBe(400);
      expect(badUnsub.body).toEqual({
        success: false,
        error: "invalid_token",
      });
    });

    it("rejects tokens sent in the query string (body-only)", async () => {
      // Tokens in URLs leak into access/proxy logs and APM URL tags, so
      // the controller deliberately ignores query params.
      const unknownToken = "a".repeat(43);
      const response = await monitorEmailConfirmRawViaQuery(unknownToken);
      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: "invalid_token",
      });
    });

    it("returns 404 JSON for unknown but well-formed tokens", async () => {
      const unknownToken = "a".repeat(43);

      const confirm = await monitorEmailConfirmRaw(unknownToken);
      expect(confirm.statusCode).toBe(404);
      expect(confirm.body).toEqual({
        success: false,
        error: "not_found",
      });

      const unsub = await monitorEmailUnsubscribeRaw(unknownToken);
      expect(unsub.statusCode).toBe(404);
      expect(unsub.body).toEqual({
        success: false,
        error: "not_found",
      });
    });

    it("does not require opt-in when recipients are unset (team-default path)", async () => {
      const create = await monitorCreateRaw(
        {
          name: "team default monitor",
          schedule: { cron: "*/30 * * * *", timezone: "UTC" },
          targets: [
            {
              type: "scrape",
              urls: [createTestIdUrl()],
              scrapeOptions: { formats: ["markdown"] },
            },
          ],
          notification: { email: { enabled: true } },
        },
        identity,
      );
      expect(create.statusCode).toBe(200);
      expect(create.body.data.emailRecipientSubscriptions).toEqual([]);

      await monitorDeleteRaw(create.body.data.id, identity);
    });
  });

  it(
    "accepts mixed json + git-diff changeTracking modes",
    async () => {
      const jsonSchema = {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", description: "The page title." },
        },
      };

      const create = await monitorCreateRaw(
        {
          name: "ct-mixed monitor",
          schedule: { cron: "*/30 * * * *", timezone: "UTC" },
          targets: [
            {
              type: "scrape",
              urls: [createTestIdUrl()],
              scrapeOptions: {
                formats: [
                  "markdown",
                  {
                    type: "changeTracking",
                    modes: ["json", "git-diff"],
                    prompt: "Extract the title.",
                    schema: jsonSchema,
                  },
                ],
              },
            },
          ],
        },
        identity,
      );
      expect(create.statusCode).toBe(200);

      const monitorId = create.body.data.id;
      const run = await monitorRunRaw(monitorId, identity);
      expect(run.statusCode).toBe(200);
      const checkId = run.body.id;

      let check: any;
      for (let i = 0; i < 90; i++) {
        const raw = await monitorCheckRaw(monitorId, checkId, identity);
        expect(raw.statusCode).toBe(200);
        check = raw.body.data;
        if (["completed", "partial", "failed"].includes(check.status)) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      expect(["completed", "partial"]).toContain(check.status);
      // First run is always "new"; the assertion here is that mixed-mode
      // configuration is accepted end-to-end without erroring.
      expect(check.pages[0].status).toBe("new");

      await monitorDeleteRaw(monitorId, identity);
    },
    2 * scrapeTimeout,
  );
});
