import express from "express";
import request from "supertest";
import { config } from "../../config";
import {
  adminAuth,
  adminSecretPathRouter,
  queueAdminRouter,
} from "../../lib/admin-auth";

const SECRET = "QueueKey{A}*b:c";
const PREVIOUS = "previous-admin-key-0002";

function buildApp() {
  const queueApp = express();
  queueApp.get("/", (req, res) =>
    res.status(200).json({ page: "queue", q: req.query.x ?? null }),
  );
  queueApp.get("/api/queues", (_req, res) =>
    res.status(200).json({ page: "api" }),
  );

  const pathRoutes = express.Router();
  pathRoutes.get("/redis-health", (_req, res) =>
    res.status(200).json({ page: "redis" }),
  );

  const ops = express.Router();
  ops.use(adminAuth);
  ops.get("/redis-health", (_req, res) =>
    res.status(200).json({ page: "ops" }),
  );

  const adminRouter = express.Router();
  adminRouter.use("/admin", adminSecretPathRouter(pathRoutes));
  adminRouter.use("/admin/ops", ops);

  const app = express();
  app.use("/admin", queueAdminRouter(queueApp));
  app.use(adminRouter);
  app.use((_req, res) => res.status(404).json({ success: false }));
  return app;
}

describe("admin path secret", () => {
  const original = {
    BULL_AUTH_KEY: config.BULL_AUTH_KEY,
    BULL_AUTH_KEY_PREVIOUS: config.BULL_AUTH_KEY_PREVIOUS,
    BULL_AUTH_KEY_PATH_ROUTES: config.BULL_AUTH_KEY_PATH_ROUTES,
  };

  beforeEach(() => {
    config.BULL_AUTH_KEY = SECRET;
    config.BULL_AUTH_KEY_PREVIOUS = PREVIOUS;
    config.BULL_AUTH_KEY_PATH_ROUTES = true;
  });

  afterEach(() => {
    config.BULL_AUTH_KEY = original.BULL_AUTH_KEY;
    config.BULL_AUTH_KEY_PREVIOUS = original.BULL_AUTH_KEY_PREVIOUS;
    config.BULL_AUTH_KEY_PATH_ROUTES = original.BULL_AUTH_KEY_PATH_ROUTES;
  });

  it("serves the queue page when the provided secret matches the configured secret", async () => {
    const app = buildApp();

    const root = await request(app).get(`/admin/${SECRET}/queues`);
    expect(root.status).toBe(200);
    expect(root.body).toEqual({ page: "queue", q: null });

    const queried = await request(app).get(`/admin/${SECRET}/queues?x=1`);
    expect(queried.status).toBe(200);
    expect(queried.body).toEqual({ page: "queue", q: "1" });

    const api = await request(app).get(`/admin/${SECRET}/queues/api/queues`);
    expect(api.status).toBe(200);
    expect(api.body).toEqual({ page: "api" });

    const health = await request(app).get(`/admin/${SECRET}/redis-health`);
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ page: "redis" });
  });

  it("serves the queue page when the configured secret contains slashes", async () => {
    config.BULL_AUTH_KEY = "ab/cd";
    const app = buildApp();

    const response = await request(app).get("/admin/ab/cd/queues");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ page: "queue", q: null });

    const mismatch = await request(app).get("/admin/ab/CD/queues");
    expect(mismatch.status).toBe(404);
    expect(mismatch.body).toEqual({ success: false });
  });

  it("does not serve the queue page when the provided secret does not match", async () => {
    const app = buildApp();
    const paths = [
      `/admin/${SECRET.toLowerCase()}/queues`,
      `/admin/${PREVIOUS}/queues`,
      `/admin/${SECRET}x/queues`,
      `/admin/${SECRET}/queues-extra`,
      `/admin/${SECRET.toLowerCase()}/redis-health`,
    ];

    for (const path of paths) {
      const response = await request(app).get(path);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ success: false });
    }
  });

  it("leaves header-authenticated admin routes in place", async () => {
    const app = buildApp();

    const ops = await request(app)
      .get("/admin/ops/redis-health")
      .set("Authorization", `Bearer ${SECRET}`);
    expect(ops.status).toBe(200);
    expect(ops.body).toEqual({ page: "ops" });

    const missing = await request(app).get("/admin/ops/redis-health");
    expect(missing.status).toBe(401);
  });

  it("does not serve path routes when they are turned off", async () => {
    config.BULL_AUTH_KEY_PATH_ROUTES = false;
    const app = buildApp();

    const queue = await request(app).get(`/admin/${SECRET}/queues`);
    expect(queue.status).toBe(404);

    const health = await request(app).get(`/admin/${SECRET}/redis-health`);
    expect(health.status).toBe(404);

    const ops = await request(app)
      .get("/admin/ops/redis-health")
      .set("Authorization", `Bearer ${SECRET}`);
    expect(ops.status).toBe(200);
  });
});
