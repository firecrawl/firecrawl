import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import { createNuqWorkerHttpApp } from "./nuq-worker-http";

function makeState() {
  let draining = false;
  let dependencyReady = true;
  let requiredLoopsReady = true;

  const app = createNuqWorkerHttpApp({
    isDraining: () => draining,
    dependencyReady: async () => dependencyReady,
    requiredLoopsReady: () => requiredLoopsReady,
    metrics: async () => "worker_metric 1\n",
  });

  return {
    app,
    setDraining(value: boolean) {
      draining = value;
    },
    setDependencyReady(value: boolean) {
      dependencyReady = value;
    },
    setRequiredLoopsReady(value: boolean) {
      requiredLoopsReady = value;
    },
  };
}

describe("NuQ worker HTTP lifecycle", () => {
  test("keeps liveness backend-independent during an outage", async () => {
    const state = makeState();
    state.setDependencyReady(false);

    await request(state.app).get("/live").expect(200, "OK");
    await request(state.app).get("/ready").expect(503, "Not Ready");
    await request(state.app).get("/health").expect(503, "Not Ready");
  });

  test("readiness requires every local required loop", async () => {
    const state = makeState();
    state.setRequiredLoopsReady(false);

    await request(state.app).get("/live").expect(200, "OK");
    await request(state.app).get("/ready").expect(503, "Not Ready");
  });

  test("drain flips readiness immediately without changing liveness", async () => {
    const state = makeState();

    await request(state.app).get("/ready").expect(200, "OK");
    state.setDraining(true);
    await request(state.app).get("/ready").expect(503, "Not Ready");
    await request(state.app).get("/live").expect(200, "OK");
  });

  test("turns required-loop health errors into unready responses", async () => {
    const onReadinessError = vi.fn();
    const app = createNuqWorkerHttpApp({
      isDraining: () => false,
      dependencyReady: async () => true,
      requiredLoopsReady: () => {
        throw new Error("loop state unavailable");
      },
      metrics: () => "",
      onReadinessError,
    });

    await request(app).get("/live").expect(200, "OK");
    await request(app).get("/ready").expect(503, "Not Ready");
    expect(onReadinessError).toHaveBeenCalledOnce();
  });

  test("turns dependency errors into unready responses", async () => {
    const onReadinessError = vi.fn();
    const app = createNuqWorkerHttpApp({
      isDraining: () => false,
      dependencyReady: async () => {
        throw new Error("FDB unavailable");
      },
      metrics: () => "",
      onReadinessError,
    });

    await request(app).get("/live").expect(200, "OK");
    await request(app).get("/ready").expect(503, "Not Ready");
    expect(onReadinessError).toHaveBeenCalledOnce();
  });

  test("serves metrics and isolates collection errors", async () => {
    const state = makeState();
    const response = await request(state.app).get("/metrics").expect(200);
    expect(response.text).toBe("worker_metric 1\n");

    const onMetricsError = vi.fn();
    const failingApp = createNuqWorkerHttpApp({
      isDraining: () => false,
      dependencyReady: async () => true,
      metrics: async () => {
        throw new Error("metrics unavailable");
      },
      onMetricsError,
    });
    await request(failingApp)
      .get("/metrics")
      .expect(500, "Metrics unavailable");
    expect(onMetricsError).toHaveBeenCalledOnce();
  });
});
