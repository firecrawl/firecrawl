import { context, propagation, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import express from "express";
import request from "supertest";
import type { TeamFlags } from "../controllers/v2/types";
import { requestTimingMiddleware } from "../routes/shared";
import { createTracerProvider, withSpan } from "./otel-tracer";
import { unhandledErrorHandler } from "./unhandled-error-handler";

// Mirrors how src/index.ts mounts the handler: after the routers, as the
// terminal error middleware.
function appUnderTest(acuc?: { team_id: string; flags: TeamFlags }) {
  const app = express();
  app.use(express.json());

  const v2 = express.Router();
  v2.use(requestTimingMiddleware("v2"));
  if (acuc) {
    // Stands in for the auth middleware, which attaches the team's limits
    // and flags to the request.
    v2.use((req, _res, next) => {
      (req as unknown as { acuc: typeof acuc }).acuc = acuc;
      next();
    });
  }
  v2.post("/boom", () => {
    throw new Error("boom");
  });
  v2.post("/traced", async (_req, _res, next) => {
    try {
      await withSpan("api.traced.request", async () => {
        throw new Error("traced boom");
      });
    } catch (error) {
      next(error);
    }
  });
  v2.post("/zdr", async (_req, _res, next) => {
    try {
      await withSpan(
        "api.zdr.request",
        async () => {
          throw new Error("zdr boom");
        },
        { zeroDataRetention: true },
      );
    } catch (error) {
      next(error);
    }
  });
  app.use("/v2", v2);
  app.use(unhandledErrorHandler);
  return app;
}

describe("unhandledErrorHandler", () => {
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider;
  const savedEnv = {
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
    OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES,
  };

  beforeAll(() => {
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    provider = createTracerProvider({ exporter, serviceName: "test-service" });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    exporter.reset();
  });

  async function exportedSpans() {
    await provider.forceFlush();
    return exporter.getFinishedSpans();
  }

  it("answers 500 with an error id and records the exception on its own span", async () => {
    const response = await request(appUnderTest()).post("/v2/boom").send({});

    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe("UNKNOWN_ERROR");

    const spans = await exportedSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span.name).toBe("api.unhandled_error");
    expect(span.attributes["http.method"]).toBe("POST");
    expect(span.attributes["http.route"]).toBe("/boom");
    expect(span.attributes["api.version"]).toBe("v2");
    expect(span.attributes["error.expected"]).toBe(false);
    expect(typeof span.attributes["error.id"]).toBe("string");
    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe("exception");
    expect(span.events[0].attributes?.["exception.message"]).toBe("boom");
  });

  it("records the exception on the request's span when the route runs under one", async () => {
    const response = await request(appUnderTest()).post("/v2/traced").send({});

    expect(response.status).toBe(500);
    const spans = await exportedSpans();
    // withSpan already recorded the throw and ended the span before the
    // handler ran; the handler must not start a second one.
    expect(spans.map(span => span.name)).toEqual(["api.traced.request"]);
    expect(spans[0].events).toHaveLength(1);
  });

  it("exports nothing for a zero-data-retention request span", async () => {
    const response = await request(appUnderTest()).post("/v2/zdr").send({});

    expect(response.status).toBe(500);
    expect(await exportedSpans()).toHaveLength(0);
  });

  it("records nothing when the request itself asks for zero data retention", async () => {
    const response = await request(appUnderTest())
      .post("/v2/boom")
      .send({ zeroDataRetention: true });

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("UNKNOWN_ERROR");
    expect(await exportedSpans()).toHaveLength(0);
  });

  it("records nothing for a Safe Mode lockdown team", async () => {
    const lockdownTeam = {
      team_id: "team-lockdown",
      flags: { safeMode: true, safeModeConfig: { lockdown: true } },
    };
    const response = await request(appUnderTest(lockdownTeam))
      .post("/v2/boom")
      .send({});

    expect(response.status).toBe(500);
    expect(await exportedSpans()).toHaveLength(0);
  });

  it("records nothing for a team whose search is forced zero data retention", async () => {
    const searchZdrTeam = {
      team_id: "team-search-zdr",
      flags: { searchZDR: "forced-zdr" as const },
    };
    const response = await request(appUnderTest(searchZdrTeam))
      .post("/v2/boom")
      .send({});

    expect(response.status).toBe(500);
    expect(await exportedSpans()).toHaveLength(0);
  });

  it("records nothing when the request asks for enterprise anonymous handling", async () => {
    const response = await request(appUnderTest())
      .post("/v2/boom")
      .send({ enterprise: ["anon"] });

    expect(response.status).toBe(500);
    expect(await exportedSpans()).toHaveLength(0);
  });

  it("records for a team whose flags do not force zero data retention", async () => {
    const plainTeam = {
      team_id: "team-plain",
      flags: { safeMode: true, safeModeConfig: { lockdown: false } },
    };
    const response = await request(appUnderTest(plainTeam))
      .post("/v2/boom")
      .send({});

    expect(response.status).toBe(500);
    const spans = await exportedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["team.id"]).toBe("team-plain");
  });

  it("keeps answering 400 for malformed JSON without recording anything", async () => {
    const response = await request(appUnderTest())
      .post("/v2/boom")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("BAD_REQUEST_INVALID_JSON");
    expect(await exportedSpans()).toHaveLength(0);
  });
});
