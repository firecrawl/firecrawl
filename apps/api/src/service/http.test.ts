import express from "express";
import type { Request, Response } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { buildV2RequestSchemas } from "../controllers/v2/types";
import {
  authenticate,
  createService,
  finalizeResponse,
  openAuth,
  openRequest,
  resolveRequestContext,
} from "./index";
import type {
  AuthModule,
  BillingModule,
  BlocklistModule,
  CoreParts,
  PolicyModule,
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

const schemaParts: CoreParts = {
  ...parts,
  buildRequestSchemas: buildV2RequestSchemas,
};

describe("openRequest", () => {
  it("parses, admits, authorizes, emits request.accepted, and transforms request.responding", async () => {
    const accepted = vi.fn();
    const app = express();
    app.use(express.json());
    app.post(
      "/scrape",
      authenticate("scrape"),
      openRequest("scrape"),
      async (req, res) => {
        const body = await finalizeResponse(req, "scrape", {
          success: true,
          ctx: req.ctx,
          id: req.requestId,
        });
        res.status(200).json(body);
      },
    );

    const svc = testService({}, schemaParts, {}, [
      {
        name: "hooks-ext",
        hooks: {
          "request.accepted": accepted,
          "request.responding": (payload, info) => ({
            ...payload,
            transformedFor: info.kind,
          }),
        },
      },
    ]);

    await withService(svc, async () => {
      const response = await request(app)
        .post("/scrape")
        .send({ url: "https://example.com", zeroDataRetention: true });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.ctx).toEqual({
        teamId: "bypass",
        zeroDataRetention: true,
      });
      expect(response.body.transformedFor).toBe("scrape");
      expect(accepted).toHaveBeenCalledTimes(1);
      expect(accepted.mock.calls[0]?.[0]).toMatchObject({
        kind: "scrape",
        id: response.body.id,
        ctx: { teamId: "bypass", zeroDataRetention: true },
      });
    });
  });

  it("emits request.rejected and halts when policy, billing, or blocklist refuses", async () => {
    const rejected = vi.fn();
    const handler = vi.fn((_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });
    const app = express();
    app.use(express.json());
    app.post("/scrape", authenticate("scrape"), openRequest("scrape"), handler);

    const policy: PolicyModule = {
      admit: async () => ({
        ok: false,
        refusal: {
          status: 403,
          body: { success: false, error: "Policy denied" },
        },
      }),
      system: purpose => ({ teamId: purpose, zeroDataRetention: false }),
    };

    await withService(
      testService({}, schemaParts, { policy }, [
        { name: "obs", hooks: { "request.rejected": rejected } },
      ]),
      async () => {
        const res = await request(app)
          .post("/scrape")
          .send({ url: "https://example.com" });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ success: false, error: "Policy denied" });
        expect(handler).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledTimes(1);
      },
    );

    const billing: BillingModule = {
      authorize: async () => ({
        ok: false,
        refusal: {
          status: 402,
          body: { success: false, error: "Insufficient credits" },
        },
      }),
      charge: async () => undefined,
    };

    await withService(
      testService({}, schemaParts, { billing }, [
        { name: "obs", hooks: { "request.rejected": rejected } },
      ]),
      async () => {
        const res = await request(app)
          .post("/scrape")
          .send({ url: "https://example.com" });
        expect(res.status).toBe(402);
        expect(rejected).toHaveBeenCalledTimes(2);
      },
    );

    const blocklist: BlocklistModule = {
      init: async () => {},
      isBlocked: url => url.includes("blocked.example"),
      hasScopedRules: () => false,
    };

    await withService(
      testService({}, schemaParts, { blocklist }, [
        { name: "obs", hooks: { "request.rejected": rejected } },
      ]),
      async () => {
        const res = await request(app)
          .post("/scrape")
          .send({ url: "https://blocked.example/page" });
        expect(res.status).toBe(403);
        expect(rejected).toHaveBeenCalledTimes(3);
      },
    );
  });

  it("uses batchScrapeNoURLValidation when ignoreInvalidURLs is true", async () => {
    const app = express();
    app.use(express.json());
    app.post(
      "/batch",
      authenticate("scrape"),
      openRequest("batchScrape"),
      (req, res) => {
        res.status(200).json({ urls: req.body.urls });
      },
    );

    await withService(testService({}, schemaParts), async () => {
      const res = await request(app)
        .post("/batch")
        .send({ urls: ["not-a-url"], ignoreInvalidURLs: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ urls: ["not-a-url"] });
    });
  });

  it("resolves context for auxiliary routes via resolveRequestContext", async () => {
    const app = express();
    app.post(
      "/aux",
      authenticate("scrape"),
      resolveRequestContext("parse-upload-url"),
      (req, res) => {
        res.status(200).json({ ctx: req.ctx });
      },
    );

    await withService(testService({}, schemaParts), async () => {
      const res = await request(app).post("/aux");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ctx: { teamId: "bypass", zeroDataRetention: false },
      });
    });
  });
});
