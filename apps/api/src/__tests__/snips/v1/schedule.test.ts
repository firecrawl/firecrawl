import { config } from "../../../config";
import {
  describeIf,
  itIf,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
  idmux,
  Identity,
  scrapeTimeout,
} from "../lib";
import request from "supertest";
import { TEST_API_URL } from "../lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "schedule",
    concurrency: 10,
    credits: 100000,
  });
}, 10000);

// Helper functions
async function createScheduleRaw(body: any, id: Identity = identity) {
  return await request(TEST_API_URL)
    .post("/v1/schedules")
    .set("Authorization", `Bearer ${id.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

async function listSchedulesRaw(id: Identity = identity) {
  return await request(TEST_API_URL)
    .get("/v1/schedules")
    .set("Authorization", `Bearer ${id.apiKey}`);
}

async function getScheduleRaw(scheduleId: string, id: Identity = identity) {
  return await request(TEST_API_URL)
    .get(`/v1/schedules/${scheduleId}`)
    .set("Authorization", `Bearer ${id.apiKey}`);
}

async function deleteScheduleRaw(scheduleId: string, id: Identity = identity) {
  return await request(TEST_API_URL)
    .delete(`/v1/schedules/${scheduleId}`)
    .set("Authorization", `Bearer ${id.apiKey}`);
}

async function updateScheduleRaw(
  scheduleId: string,
  body: any,
  id: Identity = identity,
) {
  return await request(TEST_API_URL)
    .patch(`/v1/schedules/${scheduleId}`)
    .set("Authorization", `Bearer ${id.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body);
}

// Clean up any schedules created during tests
const createdScheduleIds: string[] = [];

afterAll(async () => {
  for (const id of createdScheduleIds) {
    await deleteScheduleRaw(id).catch(() => {});
  }
});

describeIf(!TEST_SELF_HOST)("Schedule API tests", () => {
  it("creates a schedule successfully", async () => {
    const res = await createScheduleRaw({
      cron: "0 * * * *",
      url: TEST_SUITE_WEBSITE,
      mode: "scrape",
      scrapeOptions: { formats: ["markdown"] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.id).toBe("string");

    createdScheduleIds.push(res.body.id);
  }, 15000);

  it("returns 400 for invalid cron expression (empty string)", async () => {
    const res = await createScheduleRaw({
      cron: "",
      url: TEST_SUITE_WEBSITE,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe("string");
  }, 10000);

  it("returns 400 for missing url", async () => {
    const res = await createScheduleRaw({
      cron: "0 * * * *",
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  }, 10000);

  it("lists schedules for the team", async () => {
    // Create one schedule to ensure list is non-empty
    const createRes = await createScheduleRaw({
      cron: "0 0 * * *",
      url: TEST_SUITE_WEBSITE,
      name: "daily-run",
    });
    expect(createRes.statusCode).toBe(201);
    createdScheduleIds.push(createRes.body.id);

    const listRes = await listSchedulesRaw();
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.success).toBe(true);
    expect(Array.isArray(listRes.body.schedules)).toBe(true);
    expect(
      listRes.body.schedules.some((s: any) => s.id === createRes.body.id),
    ).toBe(true);
  }, 15000);

  it("gets a specific schedule by id", async () => {
    const createRes = await createScheduleRaw({
      cron: "0 6 * * *",
      url: TEST_SUITE_WEBSITE,
      name: "morning-run",
    });
    expect(createRes.statusCode).toBe(201);
    const scheduleId = createRes.body.id;
    createdScheduleIds.push(scheduleId);

    const getRes = await getScheduleRaw(scheduleId);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.success).toBe(true);
    expect(getRes.body.schedule.id).toBe(scheduleId);
    expect(getRes.body.schedule.name).toBe("morning-run");
  }, 15000);

  it("returns 404 for unknown schedule id", async () => {
    const res = await getScheduleRaw("00000000-0000-0000-0000-000000000000");
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  }, 10000);

  it("updates a schedule (pause)", async () => {
    const createRes = await createScheduleRaw({
      cron: "*/5 * * * *",
      url: TEST_SUITE_WEBSITE,
    });
    expect(createRes.statusCode).toBe(201);
    const scheduleId = createRes.body.id;
    createdScheduleIds.push(scheduleId);

    const patchRes = await updateScheduleRaw(scheduleId, { paused: true });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.body.success).toBe(true);
    expect(patchRes.body.schedule.paused).toBe(true);
  }, 15000);

  it("deletes a schedule", async () => {
    const createRes = await createScheduleRaw({
      cron: "0 12 * * *",
      url: TEST_SUITE_WEBSITE,
    });
    expect(createRes.statusCode).toBe(201);
    const scheduleId = createRes.body.id;

    const deleteRes = await deleteScheduleRaw(scheduleId);
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.success).toBe(true);

    // Verify it's gone
    const getRes = await getScheduleRaw(scheduleId);
    expect(getRes.statusCode).toBe(404);
  }, 15000);

  it("returns 401 for unauthenticated request", async () => {
    const res = await request(TEST_API_URL)
      .post("/v1/schedules")
      .set("Content-Type", "application/json")
      .send({ cron: "0 * * * *", url: TEST_SUITE_WEBSITE });

    expect(res.statusCode).toBe(401);
  }, 10000);

  // Q&A failure paths (no ANTHROPIC_API_KEY required)
  it("returns 400 when asking a schedule that has no result yet", async () => {
    const createRes = await createScheduleRaw({
      cron: "0 3 * * *", // 3am daily — won't fire during test
      url: TEST_SUITE_WEBSITE,
    });
    expect(createRes.statusCode).toBe(201);
    const scheduleId = createRes.body.id;
    createdScheduleIds.push(scheduleId);

    const askRes = await request(TEST_API_URL)
      .post(`/v1/schedules/${scheduleId}/ask`)
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send({ question: "What is this page about?" });

    expect(askRes.statusCode).toBe(400);
    expect(askRes.body.success).toBe(false);
  }, 15000);

  it("returns 404 when asking an unknown schedule", async () => {
    const res = await request(TEST_API_URL)
      .post("/v1/schedules/00000000-0000-0000-0000-000000000000/ask")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send({ question: "test" });

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  }, 10000);

  it("returns 400 when asking with an empty question", async () => {
    const createRes = await createScheduleRaw({
      cron: "0 4 * * *",
      url: TEST_SUITE_WEBSITE,
    });
    expect(createRes.statusCode).toBe(201);
    const scheduleId = createRes.body.id;
    createdScheduleIds.push(scheduleId);

    const res = await request(TEST_API_URL)
      .post(`/v1/schedules/${scheduleId}/ask`)
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send({ question: "" });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  }, 15000);

  // Q&A happy path — requires ANTHROPIC_API_KEY and a completed scrape run
  itIf(!TEST_SELF_HOST || !!process.env.ANTHROPIC_API_KEY)(
    "asks Claude a question about a scraped result",
    async () => {
      // Create a schedule that runs every minute so it fires quickly
      const createRes = await createScheduleRaw({
        cron: "* * * * *",
        url: TEST_SUITE_WEBSITE,
        scrapeOptions: { formats: ["markdown"] },
      });
      expect(createRes.statusCode).toBe(201);
      const scheduleId = createRes.body.id;
      createdScheduleIds.push(scheduleId);

      // Wait up to 70s for the first run to complete and last_result to be populated
      let lastResult: string | null = null;
      const deadline = Date.now() + 70_000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000));
        const statusRes = await getScheduleRaw(scheduleId);
        if (statusRes.body?.schedule?.last_result) {
          lastResult = statusRes.body.schedule.last_result;
          break;
        }
      }
      expect(lastResult).toBeTruthy();

      // Now ask Claude a question
      const askRes = await request(TEST_API_URL)
        .post(`/v1/schedules/${scheduleId}/ask`)
        .set("Authorization", `Bearer ${identity.apiKey}`)
        .set("Content-Type", "application/json")
        .send({
          question:
            "What is the main topic of this page? Answer in one sentence.",
        });

      expect(askRes.statusCode).toBe(200);
      expect(askRes.body.success).toBe(true);
      expect(typeof askRes.body.answer).toBe("string");
      expect(askRes.body.answer.length).toBeGreaterThan(0);
    },
    90000,
  );
});
