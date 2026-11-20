import express from "express";
import request from "supertest";

const { configured, enqueue } = vi.hoisted(() => ({
  configured: vi.fn(() => true),
  enqueue: vi.fn(async (_teamId: string) => {}),
}));

vi.mock("../../services/change-tracking-purge", () => ({
  changeTrackingPurgeConfigured: configured,
  enqueueChangeTrackingPurge: enqueue,
}));

import { changeTrackingPurgeController } from "../../controllers/admin/change-tracking-purge";

const TEAM_ID = "0000000A-0000-4000-8000-000000000001";

function app() {
  const app = express();
  app.use(express.json());
  app.post("/admin/ops/change-tracking-purge", changeTrackingPurgeController);
  return app;
}

describe("POST /admin/ops/change-tracking-purge", () => {
  beforeEach(() => {
    configured.mockReset().mockReturnValue(true);
    enqueue.mockReset().mockResolvedValue(undefined);
  });

  it("schedules the purge for the lowercased team id", async () => {
    const response = await request(app())
      .post("/admin/ops/change-tracking-purge")
      .send({ team_id: TEAM_ID });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ ok: true, queued: true });
    expect(enqueue).toHaveBeenCalledWith(TEAM_ID.toLowerCase());
  });

  it.each([{}, { team_id: "" }, { team_id: "preview_x" }, { team_id: 1 }])(
    "rejects %j without scheduling anything",
    async body => {
      const response = await request(app())
        .post("/admin/ops/change-tracking-purge")
        .send(body);

      expect(response.status).toBe(400);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it("answers 500 when the purge cannot be scheduled", async () => {
    enqueue.mockRejectedValueOnce(new Error("redis down"));

    const response = await request(app())
      .post("/admin/ops/change-tracking-purge")
      .send({ team_id: TEAM_ID });

    expect(response.status).toBe(500);
    expect(response.body.queued).toBeUndefined();
  });

  it("schedules nothing where change tracking is not stored", async () => {
    configured.mockReturnValue(false);

    const response = await request(app())
      .post("/admin/ops/change-tracking-purge")
      .send({ team_id: TEAM_ID });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, queued: false });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
