import express, { type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  authenticate,
  createService,
  openAuth,
  type AuthModule,
  type CoreParts,
} from "./index";
import { testService, withService } from "./testing";

const parts: CoreParts = {
  core: { name: "core" },
  logger: { error: vi.fn() },
};

function appWithProbe(kind = "scrape") {
  const handler = vi.fn((req: Request, res: Response) => {
    res.status(200).json({ caller: req.caller });
  });
  const app = express();
  app.get("/probe", authenticate(kind), handler);
  return { app, handler };
}

describe("authenticate", () => {
  it("admits requests under the default openAuth team", async () => {
    const { app, handler } = appWithProbe("scrape");

    await withService(createService({}, parts), async () => {
      const response = await request(app).get("/probe");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ caller: { teamId: "bypass" } });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  it("supports a custom fixed team id on openAuth", async () => {
    const { app } = appWithProbe("crawl");

    await withService(
      testService({}, parts, { auth: openAuth("self-host") }),
      async () => {
        const response = await request(app).get("/probe");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ caller: { teamId: "self-host" } });
      },
    );
  });

  it("passes the route kind, sets req.caller, and applies success headers", async () => {
    const authFn = vi.fn<AuthModule["authenticate"]>(async () => ({
      ok: true,
      caller: { teamId: "team-1" },
      headers: { "X-Auth-Scope": "full" },
    }));
    const { app, handler } = appWithProbe("custom-route");

    await withService(
      testService({}, parts, { auth: { authenticate: authFn } }),
      async () => {
        const first = await request(app).get("/probe");
        const second = await request(app).get("/probe");

        expect(first.status).toBe(200);
        expect(first.headers["x-auth-scope"]).toBe("full");
        expect(first.body).toEqual({ caller: { teamId: "team-1" } });
        expect(second.body).toEqual(first.body);
        expect(handler).toHaveBeenCalledTimes(2);
        expect(authFn.mock.calls[0]?.[1]).toEqual({ kind: "custom-route" });
      },
    );
  });

  it("answers a refusal with its status, headers, code, and body without calling the handler", async () => {
    const auth: AuthModule = {
      authenticate: async () => ({
        ok: false,
        refusal: {
          status: 429,
          headers: {
            "Retry-After": "42",
            "WWW-Authenticate":
              'Bearer resource_metadata="https://example.test"',
          },
          body: {
            success: false,
            code: "UNKNOWN_ERROR",
            error: "Rate limit exceeded",
            retry_after_seconds: 42,
          },
        },
      }),
    };
    const { app, handler } = appWithProbe("scrape");

    await withService(testService({}, parts, { auth }), async () => {
      const response = await request(app).get("/probe");

      expect(response.status).toBe(429);
      expect(response.headers["retry-after"]).toBe("42");
      expect(response.headers["www-authenticate"]).toBe(
        'Bearer resource_metadata="https://example.test"',
      );
      expect(response.body).toEqual({
        success: false,
        code: "UNKNOWN_ERROR",
        error: "Rate limit exceeded",
        retry_after_seconds: 42,
      });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it("forwards thrown auth errors to Express error middleware", async () => {
    const auth: AuthModule = {
      authenticate: () => {
        throw new Error("auth backend down");
      },
    };
    const app = express();
    app.get("/probe", authenticate("scrape"), (_req, res) =>
      res.status(200).json({ ok: true }),
    );
    app.use(
      (
        err: Error,
        _req: Request,
        res: Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).json({ caught: err.message });
      },
    );

    await withService(testService({}, parts, { auth }), async () => {
      const response = await request(app).get("/probe");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ caught: "auth backend down" });
    });
  });
});
