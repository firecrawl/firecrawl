import request from "supertest";
import { TEST_API_URL } from "./lib";

beforeAll(async () => {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      const response = await request(TEST_API_URL).get("/v0/health/liveness");
      if (response.statusCode === 200) return;
    } catch {}

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error("API did not become live within 10 seconds");
});

describe("health probes", () => {
  it("keeps liveness dependency-independent", async () => {
    const response = await request(TEST_API_URL).get("/v0/health/liveness");

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("reports ready when both shared Redis clients are healthy", async () => {
    const response = await request(TEST_API_URL).get("/v0/health/readiness");

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
