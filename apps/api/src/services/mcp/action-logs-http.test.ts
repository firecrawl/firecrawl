import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { list } = vi.hoisted(() => ({
  list: vi.fn(async (_req: Request, res: Response) =>
    res.status(200).json({ success: true, data: [] }),
  ),
}));

vi.mock("../../controllers/v2/mcp-action-logs", () => ({
  listMcpActionLogsController: list,
}));
vi.mock("../../routes/shared", () => ({
  wrap:
    (controller: any) => (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve(controller(req, res)).catch(next),
}));

import { registerMcpActionLogReadRoute } from "../../routes/mcp-action-logs";

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

describe("MCP action log read route", () => {
  beforeEach(() => {
    list.mockClear();
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
