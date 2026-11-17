import express, { type Request, type Response } from "express";
import request from "supertest";

vi.mock("../controllers/auth", () => ({
  authenticateUser: vi.fn(),
}));

import { authenticateUser } from "../controllers/auth";
import { authenticate } from "./index";

function appWithProbe() {
  const handler = vi.fn((req: Request, res: Response) => {
    res.status(200).json({ caller: req.caller });
  });
  const app = express();
  app.get("/probe", authenticate("scrape"), handler);
  return { app, handler };
}

describe("authenticate", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lets an identified sender through and says who it is", async () => {
    vi.mocked(authenticateUser).mockResolvedValue({
      success: true,
      team_id: "team-1",
      org_id: "org-1",
      chunk: null,
    });

    const { app, handler } = appWithProbe();
    const first = await request(app).get("/probe");
    const second = await request(app).get("/probe");

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ caller: { teamId: "team-1" } });
    expect(second.body).toEqual(first.body);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(vi.mocked(authenticateUser).mock.calls[0][2]).toBe("scrape");
  });

  it("answers a request it refuses and does not run the handler", async () => {
    vi.mocked(authenticateUser).mockResolvedValue({
      success: false,
      error: "Unauthorized: Invalid token",
      status: 401,
    });

    const { app, handler } = appWithProbe();
    const response = await request(app).get("/probe");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      success: false,
      error: "Unauthorized: Invalid token",
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
