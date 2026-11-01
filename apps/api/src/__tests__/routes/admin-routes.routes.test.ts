import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import express from "express";
import { register } from "prom-client";
import request from "supertest";

const { stub } = vi.hoisted(() => ({
  stub: (route: string) => async (_req: unknown, res: any) =>
    res.status(200).json({ route }),
}));

vi.mock("../../controllers/v0/admin/redis-health", () => ({
  redisHealthController: stub("redis-health"),
}));
vi.mock("../../controllers/v0/admin/autumn-health", () => ({
  autumnHealthController: stub("autumn-health"),
}));
vi.mock("../../controllers/v0/admin/check-fire-engine", () => ({
  checkFireEngine: stub("feng-check"),
}));
vi.mock("../../controllers/v0/admin/acuc-cache-clear", () => ({
  acucCacheClearController: stub("acuc-cache-clear"),
}));
vi.mock("../../controllers/v0/admin/ip-restriction-cache-clear", () => ({
  ipRestrictionCacheClearController: stub("ip-restriction-cache-clear"),
}));
vi.mock("../../controllers/v0/admin/key-restriction-cache-clear", () => ({
  keyRestrictionCacheClearController: stub("key-restriction-cache-clear"),
}));
vi.mock("../../controllers/v0/admin/concurrency-queue-backfill", () => ({
  concurrencyQueueBackfillController: stub("concurrency-queue-backfill"),
}));
vi.mock("../../controllers/v0/admin/index-queue-prometheus", () => ({
  indexQueuePrometheus: stub("index-queue-prometheus"),
}));
vi.mock("../../controllers/v0/admin/precrawl", () => ({
  triggerPrecrawl: stub("precrawl"),
}));
vi.mock("../../controllers/v0/admin/metrics", () => ({
  metricsController: stub("metrics"),
  nuqMetricsController: stub("nuq-metrics"),
  nuqFdbMetricsController: stub("nuq-fdb-metrics"),
}));
vi.mock("../../controllers/v0/admin/crawl-monitor", () => ({
  crawlMonitorController: stub("crawl-monitor"),
}));
vi.mock("../../controllers/v2/f-search", () => ({
  realtimeSearchController: stub("fsearch"),
}));
vi.mock("../../routes/shared", async importOriginal => ({
  ...(await importOriginal<typeof import("../../routes/shared")>()),
  authMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  checkCreditsMiddleware:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
}));

const CURRENT = "current-admin-key-0001";
const PREVIOUS = "previous-admin-key-0002";
const COUNTER = "firecrawl_admin_path_route_requests_total";

const KEYED_ROUTES: Array<["get" | "post", string]> = [
  ["get", "redis-health"],
  ["get", "autumn-health"],
  ["get", "feng-check"],
  ["post", "acuc-cache-clear"],
  ["post", "ip-restriction-cache-clear"],
  ["post", "key-restriction-cache-clear"],
  ["post", "concurrency-queue-backfill"],
  ["get", "index-queue-prometheus"],
  ["get", "precrawl"],
  ["get", "metrics"],
  ["get", "nuq-metrics"],
  ["get", "nuq-fdb-metrics"],
  ["post", "fsearch"],
];

async function adminApp(pathRoutes: boolean) {
  vi.resetModules();
  register.clear();
  const { config } = await import("../../config.js");
  config.BULL_AUTH_KEY = CURRENT;
  config.BULL_AUTH_KEY_PREVIOUS = PREVIOUS;
  config.BULL_AUTH_KEY_PATH_ROUTES = pathRoutes;
  const { logger } = await import("../../lib/logger.js");
  const { adminRouter } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  app.use(adminRouter);
  return { app, logger };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin routes with the key in a header", () => {
  it("serves every keyed route under /admin/ops with either key", async () => {
    const { app } = await adminApp(false);
    for (const [method, route] of KEYED_ROUTES) {
      for (const key of [CURRENT, PREVIOUS]) {
        const response = await request(app)
          [method](`/admin/ops/${route}`)
          .set("Authorization", `Bearer ${key}`);
        expect(response.status, route).toBe(200);
        expect(response.body).toEqual({ route });
      }
    }
  });

  it("serves crawl-monitor with either key in the admin key header", async () => {
    const { app } = await adminApp(false);
    for (const key of [CURRENT, PREVIOUS]) {
      const response = await request(app)
        .post("/admin/ops/crawl-monitor")
        .set("x-firecrawl-admin-key", key);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ route: "crawl-monitor" });
    }
    const missing = await request(app).post("/admin/ops/crawl-monitor");
    expect(missing.status).toBe(401);
  });

  it("refuses every keyed route under /admin/ops without the key", async () => {
    const { app } = await adminApp(false);
    for (const [method, route] of KEYED_ROUTES) {
      const response = await request(app)[method](`/admin/ops/${route}`);
      expect(response.status, route).toBe(401);
    }
  });
});

it("redacts a path key in plain or URL-encoded form", async () => {
  vi.resetModules();
  register.clear();
  const { config } = await import("../../config.js");
  config.BULL_AUTH_KEY = "key/with+chars";
  const { redactAdminKey } = await import("../../lib/admin-auth.js");
  expect(redactAdminKey("/admin/key%2Fwith%2Bchars/metrics")).toBe(
    "/admin/:bullAuthKey/metrics",
  );
  expect(redactAdminKey("/admin/%E0%A4%A/metrics")).toBe(
    "/admin/%E0%A4%A/metrics",
  );
});

describe("admin routes with the key in the path", () => {
  it("serves the same routes through the same key check and counts each use", async () => {
    const { app, logger } = await adminApp(true);
    const info = vi.spyOn(logger, "info");

    for (const [method, route] of KEYED_ROUTES) {
      const response = await request(app)
        [method](`/admin/${PREVIOUS}/${route}`)
        .set("User-Agent", "Prometheus/3.0");
      expect(response.status, route).toBe(200);
      expect(response.body).toEqual({ route });
    }

    const monitor = await request(app).post(`/admin/${CURRENT}/crawl-monitor`);
    expect(monitor.status).toBe(200);
    expect(monitor.body).toEqual({ route: "crawl-monitor" });

    const counted = await register.getSingleMetric(COUNTER)!.get();
    expect(counted.values).toContainEqual(
      expect.objectContaining({
        labels: { route: "metrics", caller: "prometheus" },
        value: 1,
      }),
    );
    expect(JSON.stringify(counted)).not.toContain(PREVIOUS);
    expect(JSON.stringify(info.mock.calls)).not.toContain(PREVIOUS);
  });

  it("answers 404 for a wrong key, as for an unknown path", async () => {
    const { app } = await adminApp(true);
    for (const key of [`${CURRENT}x`, CURRENT.slice(0, -1)]) {
      const response = await request(app).get(`/admin/${key}/metrics`);
      expect(response.status).toBe(404);
    }
  });

  it("is off when BULL_AUTH_KEY_PATH_ROUTES is false", async () => {
    const { app } = await adminApp(false);
    const response = await request(app).get(`/admin/${CURRENT}/metrics`);
    expect(response.status).toBe(404);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    return file.endsWith(".ts") ? [file] : [];
  });
}

it("no caller puts the admin key in a URL", () => {
  const src = path.resolve(__dirname, "../..");
  // The server's own queue UI base path, which goes when the path routes do.
  const allowed = new Set([path.join(src, "index.ts")]);
  const key = /BULL_AUTH_KEY(?!_PATH_ROUTES)/;

  const offenders = sourceFiles(src).filter(
    file =>
      !allowed.has(file) &&
      readFileSync(file, "utf8")
        .split("\n")
        .some(line => line.includes("/admin/") && key.test(line)),
  );

  expect(offenders).toEqual([]);
});
