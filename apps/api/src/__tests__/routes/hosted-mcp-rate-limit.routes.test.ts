import express from "express";
import type { Request, Response } from "express";
import request from "supertest";
import { z } from "zod";
import type { authMiddleware } from "../../routes/shared";

// Real routers; auth is stubbed to answer with the options its route passed,
// so each request shows whether the route opts in to the hosted MCP minimums.
vi.mock("../../routes/shared", async importOriginal => {
  const actual = await importOriginal<{
    authMiddleware: typeof authMiddleware;
  }>();
  return {
    ...actual,
    authMiddleware:
      (_mode: unknown, options: { hostedMcpRateLimit?: boolean } = {}) =>
      (_req: Request, res: Response) => {
        res
          .status(200)
          .json({ hostedMcpRateLimit: options.hostedMcpRateLimit === true });
      },
  };
});

import { v2Router } from "../../routes/v2";

const app = express();
app.use(express.json());
app.use("/v2", v2Router);

const hostedMcpRateLimitBodySchema = z.object({
  hostedMcpRateLimit: z.boolean(),
});

async function optsIn(path: string): Promise<boolean> {
  const res = await request(app).post(path).send({});
  expect(res.status).toBe(200);
  return hostedMcpRateLimitBodySchema.parse(res.body).hostedMcpRateLimit;
}

describe("hosted MCP rate-limit opt-in", () => {
  it.each([
    "/v2/scrape",
    "/v2/search",
    "/v2/batch/scrape",
    "/v2/parse",
    "/v2/parse/upload-url",
    "/v2/map",
    "/v2/crawl",
  ])("is set on %s", async path => {
    expect(await optsIn(path)).toBe(true);
  });
});
