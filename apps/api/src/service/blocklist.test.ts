import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startupMocks = vi.hoisted(() => ({
  initializeEngineForcing: vi.fn(),
}));

vi.mock("../scraper/WebScraper/utils/engine-forcing", () => ({
  initializeEngineForcing: startupMocks.initializeEngineForcing,
}));

import type { TeamFlags } from "../controllers/v2/types";
import { initializeApiStartupDependencies } from "../lib/api-startup";
import { logger } from "../lib/logger";
import { UNSUPPORTED_SITE_MESSAGE } from "../lib/strings";
import { blocklistMiddleware } from "../routes/shared";
import { defaultModules, noBlocklist } from "./defaults";
import type { BlocklistModule } from "./modules";
import { createService, replaceService, run } from "./service";
import type { CoreParts } from "./service";
import { testService, withService } from "./testing";

const parts: CoreParts = {
  core: { name: "core" },
  logger: { error: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  replaceService(undefined);
  vi.restoreAllMocks();
});

interface BlocklistMiddlewareInput {
  body: {
    url?: string;
    origin?: string;
    zeroDataRetention?: boolean;
  };
  acuc: {
    team_id: string;
    org_id: string | null;
    flags: TeamFlags;
  };
}

async function runBlocklistMiddleware(
  input: BlocklistMiddlewareInput,
): Promise<{ next: true } | { status: number; body: unknown }> {
  let calledNext = false;
  let caughtError: unknown;
  const app = express();
  app.use(express.json());
  app.post(
    "/probe",
    (req, _res, next) => {
      Object.assign(req, { acuc: input.acuc });
      next();
    },
    blocklistMiddleware,
    (_req, res) => {
      calledNext = true;
      res.status(200).end();
    },
  );
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      caughtError = err;
      res.status(500).end();
    },
  );

  const response = await request(app).post("/probe").send(input.body);
  if (caughtError !== undefined) {
    throw caughtError;
  }
  if (calledNext) {
    return { next: true };
  }
  const body: unknown = response.body;
  return { status: response.status, body };
}

describe("blocklist module integration", () => {
  it("allows requests through blocklistMiddleware under noBlocklist()", async () => {
    const svc = testService(defaultModules(), parts);

    await withService(svc, async () => {
      await expect(
        runBlocklistMiddleware({
          body: { url: "https://example.com/page", origin: "api" },
          acuc: { team_id: "team-1", org_id: "org-1", flags: {} },
        }),
      ).resolves.toEqual({ next: true });
    });
  });

  it("blocks matching URLs through blocklistMiddleware when a custom blocklist is injected via withService", async () => {
    const isBlocked = vi.fn(
      (url: string) => new URL(url).hostname === "blocked.example",
    );
    const customBlocklist: BlocklistModule = {
      ...noBlocklist(),
      isBlocked,
    };

    await withService(
      testService(defaultModules(), parts, { blocklist: customBlocklist }),
      async () => {
        const blocked = await runBlocklistMiddleware({
          body: {
            url: "https://blocked.example/profile",
            origin: "sdk",
            zeroDataRetention: true,
          },
          acuc: {
            team_id: "team-1",
            org_id: "org-1",
            flags: { unblockedDomains: ["other.example"] },
          },
        });

        expect(blocked).toEqual({
          status: 403,
          body: {
            success: false,
            error: UNSUPPORTED_SITE_MESSAGE,
          },
        });
        expect(isBlocked).toHaveBeenCalledWith(
          "https://blocked.example/profile",
          expect.objectContaining({
            teamId: "team-1",
            orgId: "org-1",
            zeroDataRetention: true,
            flags: { unblockedDomains: ["other.example"] },
          }),
          { origin: "sdk" },
        );

        const allowed = await runBlocklistMiddleware({
          body: { url: "https://allowed.example/page" },
          acuc: { team_id: "team-1", org_id: null, flags: null },
        });
        expect(allowed).toEqual({ next: true });

        // Non-string URLs bypass the blocklist check.
        isBlocked.mockClear();
        const missingUrl = await runBlocklistMiddleware({
          body: {},
          acuc: { team_id: "team-1", org_id: null, flags: null },
        });
        expect(missingUrl).toEqual({ next: true });
        expect(isBlocked).not.toHaveBeenCalled();
      },
    );
  });

  it("forwards forced ZDR into zeroDataRetention on blocklistMiddleware", async () => {
    const isBlocked = vi.fn(() => false);
    const customBlocklist: BlocklistModule = {
      ...noBlocklist(),
      isBlocked,
    };

    await withService(
      testService(defaultModules(), parts, { blocklist: customBlocklist }),
      async () => {
        await runBlocklistMiddleware({
          body: { url: "https://example.com" },
          acuc: {
            team_id: "team-1",
            org_id: "org-1",
            flags: { scrapeZDR: "forced" },
          },
        });

        expect(isBlocked).toHaveBeenCalledWith(
          "https://example.com",
          expect.objectContaining({
            teamId: "team-1",
            orgId: "org-1",
            zeroDataRetention: true,
          }),
          { origin: null },
        );
      },
    );
  });

  it("awaits blocklist.init() in initializeApiStartupDependencies() before starting other API dependencies", async () => {
    const order: Array<string> = [];
    startupMocks.initializeEngineForcing.mockImplementation(() => {
      order.push("engine-forcing");
    });

    const okService = createService(
      {
        modules: {
          blocklist: {
            ...noBlocklist(),
            async init() {
              order.push("init:start");
              await Promise.resolve();
              order.push("init:done");
            },
          },
        },
      },
      {
        core: {
          name: "core",
          workers: {
            api: {
              run: initializeApiStartupDependencies,
            },
          },
        },
        logger: { error: vi.fn() },
      },
    );

    await expect(
      run(okService, "api", "/app/main.js"),
    ).resolves.toBeUndefined();
    expect(order).toEqual(["init:start", "init:done", "engine-forcing"]);

    replaceService(undefined);
    vi.clearAllMocks();

    const loggerErrorSpy = vi
      .spyOn(logger, "error")
      .mockImplementation(() => logger);
    const initError = new Error("blocklist failed to load");
    const failingService = createService(
      {
        modules: {
          blocklist: {
            ...noBlocklist(),
            async init() {
              throw initError;
            },
          },
        },
      },
      {
        core: {
          name: "core",
          workers: {
            api: {
              run: initializeApiStartupDependencies,
            },
          },
        },
        logger: { error: vi.fn() },
      },
    );

    await expect(run(failingService, "api", "/app/main.js")).rejects.toThrow(
      "blocklist failed to load",
    );
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      "Failed to initialize API startup dependencies",
      { error: initError },
    );
    expect(startupMocks.initializeEngineForcing).not.toHaveBeenCalled();
  });
});
