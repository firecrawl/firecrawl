import bodyParser from "body-parser";
import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config";

const { ingest, list } = vi.hoisted(() => ({
  ingest: vi.fn(async (_req: Request, res: Response) =>
    res.status(202).json({ success: true }),
  ),
  list: vi.fn(async (_req: Request, res: Response) =>
    res.status(200).json({ success: true, data: [] }),
  ),
}));

vi.mock("../../controllers/v2/mcp-action-logs", () => ({
  ingestMcpActionLogController: ingest,
  listMcpActionLogsController: list,
}));
vi.mock("../../routes/shared", () => ({
  wrap:
    (controller: any) => (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve(controller(req, res)).catch(next),
}));

import {
  createMcpActionLogRateLimitMiddleware,
  registerMcpActionLogIngestRoute,
  registerMcpActionLogReadRoute,
  timingSafeSecretEqual,
} from "../../routes/mcp-action-logs";

function app(rateLimit = createMcpActionLogRateLimitMiddleware()) {
  const server = express();
  registerMcpActionLogIngestRoute(server, { rateLimit });
  server.use(bodyParser.json({ limit: "10mb" }));
  server.use(
    (error: any, _req: Request, res: Response, _next: NextFunction) => {
      if (error?.status === 413) {
        return res
          .status(413)
          .json({ success: false, error: "Request body is too large" });
      }
      return res.status(500).json({ success: false, error: "unexpected" });
    },
  );
  return server;
}

function readApp() {
  const server = express();
  const router = express.Router();
  registerMcpActionLogReadRoute(router, (req, res, next) => {
    if (req.headers.authorization !== "Bearer owner-key") {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    next();
  });
  server.use("/v2", router);
  return server;
}

describe("MCP action log ingest route", () => {
  beforeEach(() => {
    config.MCP_ACTION_LOG_SECRET = "test-secret";
    config.MCP_ACTION_LOG_STORAGE_ENABLED = true;
    config.MCP_ACTION_LOG_WRITES_ENABLED = true;
    ingest.mockClear();
    list.mockClear();
  });

  it("is disabled by default through an explicit write flag", async () => {
    config.MCP_ACTION_LOG_WRITES_ENABLED = false;
    const response = await request(app())
      .post("/v2/mcp/action-logs")
      .set("Authorization", "Bearer test-secret")
      .send({});
    expect(response.status).toBe(503);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("defensively rejects writes when storage is disabled", async () => {
    config.MCP_ACTION_LOG_STORAGE_ENABLED = false;
    const response = await request(app())
      .post("/v2/mcp/action-logs")
      .set("Authorization", "Bearer test-secret")
      .send({});
    expect(response.status).toBe(503);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("uses a timing-safe shared-secret comparison", async () => {
    expect(timingSafeSecretEqual("test-secret", "test-secret")).toBe(true);
    expect(timingSafeSecretEqual("short", "long-secret")).toBe(false);
    const response = await request(app()).post("/v2/mcp/action-logs").send({});
    expect(response.status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("enforces the dedicated 64 KB body limit before the global parser", async () => {
    const response = await request(app())
      .post("/v2/mcp/action-logs")
      .set("Authorization", "Bearer test-secret")
      .send({ padding: "x".repeat(65 * 1024) });
    expect(response.status).toBe(413);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("enforces the body limit for non-JSON content types", async () => {
    const response = await request(app())
      .post("/v2/mcp/action-logs")
      .set("Authorization", "Bearer test-secret")
      .set("Content-Type", "text/plain")
      .send("x".repeat(65 * 1024));
    expect(response.status).toBe(413);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rate limits accepted writers with Retry-After", async () => {
    const server = app(
      createMcpActionLogRateLimitMiddleware({
        limit: 1,
        windowMs: 10_000,
        now: () => 1_000,
      }),
    );
    const send = () =>
      request(server)
        .post("/v2/mcp/action-logs")
        .set("Authorization", "Bearer test-secret")
        .send({});
    expect((await send()).status).toBe(202);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("10");
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("rejects new authenticated sources at capacity without evicting active buckets", () => {
    const rateLimit = createMcpActionLogRateLimitMiddleware({
      limit: 1,
      windowMs: 10_000,
      maxBuckets: 2,
      now: () => 1_000,
    });
    const invoke = (ip: string) => {
      const next = vi.fn();
      const res = {
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;
      rateLimit({ ip, socket: {} } as any, res, next);
      return { next, res };
    };

    expect(invoke("source-a").next).toHaveBeenCalledTimes(1);
    expect(invoke("source-b").next).toHaveBeenCalledTimes(1);
    const rejected = invoke("source-c");
    expect(rejected.next).not.toHaveBeenCalled();
    expect(rejected.res.status).toHaveBeenCalledWith(429);
    expect(rejected.res.json).toHaveBeenCalledWith({
      success: false,
      error: "Too many MCP action log sources",
    });
    const stillLimited = invoke("source-a");
    expect(stillLimited.next).not.toHaveBeenCalled();
    expect(stillLimited.res.status).toHaveBeenCalledWith(429);
  });

  it("wires the activity read route behind account authentication", async () => {
    const server = readApp();
    expect((await request(server).get("/v2/mcp/action-logs")).status).toBe(401);
    expect(list).not.toHaveBeenCalled();

    const accepted = await request(server)
      .get("/v2/mcp/action-logs")
      .set("Authorization", "Bearer owner-key");
    expect(accepted.status).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
