import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { config } from "../../../config";
import {
  changeTrackingGetLastScrape,
  changeTrackingInsertScrape,
} from "../../../lib/change-tracking-store";
import { describeIf, TEST_API_URL, TEST_PRODUCTION } from "../lib";
import { idmux } from "./lib";

// The first purge pass runs 30s after it is scheduled.
const FIRST_PASS_MS = 30 * 1000;
const PURGE_TIMEOUT_MS = 3 * 60 * 1000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function changeTrackingPurge(teamId: unknown) {
  return request(TEST_API_URL)
    .post("/admin/ops/change-tracking-purge")
    .set("Authorization", `Bearer ${config.BULL_AUTH_KEY}`)
    .send({ team_id: teamId });
}

/** Writes one change tracking row for the team and returns a reader for it. */
async function writeRow(teamId: string) {
  const url = `https://firecrawl.dev/?purge=${crypto.randomUUID()}`;
  await changeTrackingInsertScrape({
    team_id: teamId,
    url,
    job_id: uuidv7(),
    tag: null,
    date_added: new Date(),
  });
  const read = () =>
    changeTrackingGetLastScrape({ team_id: teamId, url, tag: null });
  expect(await read()).not.toBeNull();
  return read;
}

describeIf(TEST_PRODUCTION)("Change tracking purge", () => {
  it(
    "deletes the rows of a team that no longer exists",
    async () => {
      // Random ids have no team row, as after the dashboard deletes a team.
      const teamId = crypto.randomUUID();
      const bystanderId = crypto.randomUUID();
      const purged = await writeRow(teamId);
      const bystander = await writeRow(bystanderId);

      const response = await changeTrackingPurge(teamId);
      expect(response.statusCode).toBe(202);
      expect(response.body).toEqual({ ok: true, queued: true });

      const deadline = Date.now() + PURGE_TIMEOUT_MS - 15 * 1000;
      let row = await purged();
      while (row !== null && Date.now() < deadline) {
        await sleep(5 * 1000);
        row = await purged();
      }
      expect(row).toBeNull();
      expect(await bystander()).not.toBeNull();

      expect((await changeTrackingPurge(bystanderId)).statusCode).toBe(202);
    },
    PURGE_TIMEOUT_MS,
  );

  it(
    "keeps the rows of a team that still exists",
    async () => {
      const identity = await idmux({
        name: "change-tracking-purge/live-team",
        credits: 100,
      });
      const read = await writeRow(identity.teamId);

      const response = await changeTrackingPurge(identity.teamId);
      expect(response.statusCode).toBe(202);

      await sleep(FIRST_PASS_MS + 45 * 1000);
      expect(await read()).not.toBeNull();
    },
    PURGE_TIMEOUT_MS,
  );

  it("rejects a team id that is not a UUID", async () => {
    const response = await changeTrackingPurge("not-a-team");
    expect(response.statusCode).toBe(400);
  });
});
