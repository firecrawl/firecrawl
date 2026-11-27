import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { Response } from "express";
import { register } from "prom-client";
import request from "supertest";

const { stub } = vi.hoisted(() => ({
  stub: (route: string) => async (_req: unknown, res: Response) => {
    res.status(200).json({ route });
  },
}));

vi.mock("../../controllers/admin/redis-health", () => ({
  redisHealthController: stub("redis-health"),
}));
vi.mock("../../controllers/admin/concurrency-queue-backfill", () => ({
  concurrencyQueueBackfillController: stub("concurrency-queue-backfill"),
}));
vi.mock("../../controllers/admin/metrics", () => ({
  metricsController: stub("metrics"),
  nuqMetricsController: stub("nuq-metrics"),
  nuqFdbMetricsController: stub("nuq-fdb-metrics"),
}));

const CURRENT = "current-admin-key-0001";
const PREVIOUS = "previous-admin-key-0002";
const COUNTER = "firecrawl_admin_path_route_requests_total";

const KEYED_ROUTES: Array<["get" | "post", string]> = [
  ["get", "redis-health"],
  ["post", "concurrency-queue-backfill"],
  ["get", "metrics"],
  ["get", "nuq-metrics"],
  ["get", "nuq-fdb-metrics"],
];

const INTERNAL_ROUTES: Array<["get" | "post", string]> = [
  ["get", "redis-health"],
  ["get", "metrics"],
  ["get", "nuq-metrics"],
  ["get", "nuq-fdb-metrics"],
];

async function adminApp(pathRoutes: boolean) {
  vi.resetModules();
  register.clear();
  const { config } = await import("../../config.js");
  config.BULL_AUTH_KEY = CURRENT;
  config.BULL_AUTH_KEY_PREVIOUS = PREVIOUS;
  config.BULL_AUTH_KEY_PATH_ROUTES = pathRoutes;
  const { logger } = await import("../../lib/logger.js");
  const { adminInternalRouter, adminRouter } =
    await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  app.use(adminRouter);

  const internalApp = express();
  internalApp.use(express.json());
  internalApp.use(adminInternalRouter);
  return { app, internalApp, logger };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin routes with the key in a header", () => {
  it("serves every keyed route under /admin/ops with either key", async () => {
    const { app } = await adminApp(false);
    for (const [method, route] of KEYED_ROUTES) {
      for (const key of [CURRENT, PREVIOUS]) {
        const req = request(app);
        const response = await req[method](`/admin/ops/${route}`).set(
          "Authorization",
          `Bearer ${key}`,
        );
        expect(response.status, route).toBe(200);
        expect(response.body).toEqual({ route });
      }
    }
  });

  it("refuses every keyed route under /admin/ops without the key", async () => {
    const { app } = await adminApp(false);
    for (const [method, route] of KEYED_ROUTES) {
      const response = await request(app)[method](`/admin/ops/${route}`);
      expect(response.status, route).toBe(401);
    }
  });
});

describe("internal admin routes", () => {
  it("serves every core internal route without a key", async () => {
    const { internalApp } = await adminApp(false);
    for (const [method, route] of INTERNAL_ROUTES) {
      const response = await request(internalApp)[method](`/admin/${route}`);
      expect(response.status, route).toBe(200);
      expect(response.body).toEqual({ route });
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

it("keeps a path key out of metric route labels and not-found bodies", async () => {
  vi.resetModules();
  register.clear();
  const { config } = await import("../../config.js");
  config.BULL_AUTH_KEY = CURRENT;
  config.BULL_AUTH_KEY_PREVIOUS = PREVIOUS;
  const { getRoutePattern } = await import("../../lib/http-metrics.js");
  const { notFoundHandler } = await import("../../lib/not-found.js");

  let observedRoutePattern: string | undefined;
  const probeApp = express();
  probeApp.use((req, res) => {
    observedRoutePattern = getRoutePattern(req);
    res.status(200).end();
  });
  await request(probeApp).get(`/admin/${PREVIOUS}/queues/api/queues`);
  expect(observedRoutePattern).toBe("/admin/:bullAuthKey/queues/api/queues");

  const app = express();
  app.use(notFoundHandler);
  const response = await request(app).get(`/admin/${CURRENT}/nope`);
  expect(response.status).toBe(404);
  expect(JSON.stringify(response.body)).not.toContain(CURRENT);
});

describe("admin routes with the key in the path", () => {
  it("serves the same routes through the same key check and counts each use", async () => {
    const { app, logger } = await adminApp(true);
    const info = vi.spyOn(logger, "info");

    for (const [method, route] of KEYED_ROUTES) {
      const req = request(app);
      const response = await req[method](`/admin/${PREVIOUS}/${route}`).set(
        "User-Agent",
        "Prometheus/3.0",
      );
      expect(response.status, route).toBe(200);
      expect(response.body).toEqual({ route });
    }

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

  it("supports an explicit bounded route label in adminPathKeyAuth", async () => {
    vi.resetModules();
    register.clear();
    const { config } = await import("../../config.js");
    config.BULL_AUTH_KEY = CURRENT;
    config.BULL_AUTH_KEY_PREVIOUS = PREVIOUS;
    const { adminPathKeyAuth } = await import("../../lib/admin-auth.js");

    const app = express();
    const pathRouter = express.Router({ mergeParams: true });
    pathRouter.get(
      "/custom-check",
      adminPathKeyAuth("custom-check"),
      (_req, res) => res.status(200).json({ ok: true }),
    );
    app.use("/admin/:adminKey", pathRouter);

    const ok = await request(app)
      .get(`/admin/${CURRENT}/custom-check`)
      .set("User-Agent", "Prometheus/3.0");
    expect(ok.status).toBe(200);

    const bad = await request(app).get(`/admin/${CURRENT}x/custom-check`);
    expect(bad.status).toBe(404);

    const counted = await register.getSingleMetric(COUNTER)!.get();
    expect(counted.values).toContainEqual(
      expect.objectContaining({
        labels: { route: "custom-check", caller: "prometheus" },
        value: 1,
      }),
    );
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

function sourceFiles(dir: string): Array<string> {
  return readdirSync(dir).flatMap(name => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) {
      return sourceFiles(file);
    }
    return file.endsWith(".ts") ? [file] : [];
  });
}

it("no caller puts the admin key in a URL", () => {
  const src = path.resolve(__dirname, "../..");
  // The server's own queue UI base path, which goes when the path routes do.
  const allowed = new Set([path.join(src, "index.ts")]);
  const keyRef = /BULL_AUTH_KEY(?!_PATH_ROUTES)/;
  // Names bound to the key elsewhere in the file, such as `const k = config.BULL_AUTH_KEY`.
  const alias =
    /(?:\b(\w+)\s*=(?!=)[^;\n]*|\bBULL_AUTH_KEY(?:_PREVIOUS)?\s*:\s*(\w+)\b)/g;

  const offenders = sourceFiles(src).filter(file => {
    if (allowed.has(file)) {
      return false;
    }
    const text = readFileSync(file, "utf8");
    const names = new Set<string>();
    for (const line of text.split("\n")) {
      if (!keyRef.test(line)) {
        continue;
      }
      for (const match of line.matchAll(alias)) {
        if (match[1] && /=[^;\n]*BULL_AUTH_KEY/.test(line.slice(match.index))) {
          names.add(match[1]);
        }
        if (match[2]) {
          names.add(match[2]);
        }
      }
    }
    const aliasRef = names.size
      ? new RegExp(`\\b(?:${[...names].join("|")})\\b`)
      : null;
    return text
      .split("\n")
      .some(
        line =>
          line.includes("/admin/") &&
          (keyRef.test(line) || (aliasRef?.test(line) ?? false)),
      );
  });

  expect(offenders).toEqual([]);
});
