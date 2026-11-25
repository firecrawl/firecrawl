import express from "express";
import request from "supertest";
import { v7 as uuidv7 } from "uuid";

vi.mock("geoip-country", () => ({ lookup: vi.fn(() => null) }));

import { idempotencyMiddleware } from "../../routes/shared";
import {
  defaultModules,
  redisIdempotency,
  type CoreParts,
} from "../../service";
import { testService, withService } from "../../service/testing";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

function buildApp(teamSource?: "ctx" | "caller" | "auth" | "none") {
  const app = express();
  app.post(
    "/test",
    (req: any, _res, next) => {
      if (teamSource === "ctx") {
        req.ctx = { teamId: "team-ctx", zeroDataRetention: false };
      } else if (teamSource === "caller") {
        req.caller = { teamId: "team-caller" };
      } else if (teamSource === "auth") {
        req.auth = { team_id: "team-auth" };
      }
      next();
    },
    idempotencyMiddleware,
    (_req, res) => res.status(200).json({ success: true }),
  );
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ success: false, error: err.message });
    },
  );
  return app;
}

describe("idempotencyMiddleware", () => {
  it("passes through without calling claim when x-idempotency-key is omitted", async () => {
    const claim = vi.fn(async () => true);
    await withService(
      testService(defaultModules(), parts, { idempotency: { claim } }),
      async () => {
        const res = await request(buildApp("caller")).post("/test");
        expect(res.status).toBe(200);
        expect(claim).not.toHaveBeenCalled();
      },
    );
  });

  it("rejects non-UUID keys with 409 without calling claim", async () => {
    const claim = vi.fn(async () => true);
    await withService(
      testService(defaultModules(), parts, { idempotency: { claim } }),
      async () => {
        const res = await request(buildApp("caller"))
          .post("/test")
          .set("x-idempotency-key", "not-a-uuid");
        expect(res.status).toBe(409);
        expect(res.body).toEqual({
          success: false,
          error: "Idempotency key already used",
        });
        expect(claim).not.toHaveBeenCalled();
      },
    );
  });

  it("claims valid UUID keys once per team and rejects duplicates with 409", async () => {
    const seen = new Set<string>();
    const idempotency = redisIdempotency({
      setIfAbsent: async key => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    });
    const key = uuidv7();

    await withService(
      testService(defaultModules(), parts, { idempotency }),
      async () => {
        const callerApp = buildApp("caller");
        const first = await request(callerApp)
          .post("/test")
          .set("x-idempotency-key", key);
        expect(first.status).toBe(200);

        const duplicate = await request(callerApp)
          .post("/test")
          .set("x-idempotency-key", key);
        expect(duplicate.status).toBe(409);
        expect(duplicate.body).toEqual({
          success: false,
          error: "Idempotency key already used",
        });

        // A different team can claim the same UUID independently.
        const otherTeam = await request(buildApp("auth"))
          .post("/test")
          .set("x-idempotency-key", key);
        expect(otherTeam.status).toBe(200);
      },
    );
  });

  it("resolves teamId from req.ctx, then req.caller, then req.auth, then bypass", async () => {
    const claim = vi.fn(async () => true);
    await withService(
      testService(defaultModules(), parts, { idempotency: { claim } }),
      async () => {
        for (const [source, expectedTeamId] of [
          ["ctx", "team-ctx"],
          ["caller", "team-caller"],
          ["auth", "team-auth"],
          ["none", "bypass"],
        ] as const) {
          const key = uuidv7();
          const res = await request(buildApp(source))
            .post("/test")
            .set("x-idempotency-key", key);
          expect(res.status).toBe(200);
          expect(claim).toHaveBeenLastCalledWith(key, {
            teamId: expectedTeamId,
          });
        }
      },
    );
  });

  it("forwards claim errors to Express error middleware instead of crashing", async () => {
    const claim = vi.fn(async () => {
      throw new Error("redis unavailable");
    });
    await withService(
      testService(defaultModules(), parts, { idempotency: { claim } }),
      async () => {
        const res = await request(buildApp("caller"))
          .post("/test")
          .set("x-idempotency-key", uuidv7());
        expect(res.status).toBe(500);
        expect(res.body).toEqual({
          success: false,
          error: "redis unavailable",
        });
      },
    );
  });
});
