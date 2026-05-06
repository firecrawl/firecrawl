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
});
