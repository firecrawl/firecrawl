import "dotenv/config";
import { config } from "./config";
import { shutdownTracing } from "./otel";
import express, { NextFunction, Request, Response } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { getPrecrawlQueue } from "./services/queue-service";
import { bindBullBoard } from "./lib/bull-board-registry";
import { livenessController, readinessController } from "./controllers/health";
import { startNodeRuntimeMetrics } from "./lib/node-runtime-metrics";
import os from "os";
import { logger } from "./lib/logger";
import { adminInternalRouter, adminRouter } from "./routes/admin";
import {
  AdminKeySlot,
  adminAuth,
  adminPathKeyAuth,
  redactAdminKey,
} from "./lib/admin-auth";
import http from "node:http";
import https from "node:https";
import expressWs from "express-ws";
import { ErrorResponse, RequestWithMaybeACUC } from "./controllers/v2/types";
import { ZodError } from "zod";
import { QueueFullError } from "./lib/queue-full-error";
import { v7 as uuidv7 } from "uuid";
import { cacheableLookup } from "./scraper/scrapeURL/lib/cacheableLookup";
import { v2Router } from "./routes/v2";
import { nuqShutdown } from "./services/worker/nuq";
import { service } from "./service";
import { installedService, runProcessStop } from "./service/service";
import { initializeApiStartupDependencies } from "./lib/api-startup";
import responseTime from "response-time";
import { notFoundHandler } from "./lib/not-found";
import { startRole } from "./main";

const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { ExpressAdapter } = require("@bull-board/express");

const numCPUs = config.ENV === "local" ? 2 : os.cpus().length;
logger.info(`Number of CPUs: ${numCPUs} available`);

logger.info("Network info dump", {
  networkInterfaces: os.networkInterfaces(),
});

// Install cacheable lookup for all other requests
cacheableLookup.install(http.globalAgent);
cacheableLookup.install(https.globalAgent);

// Initialize Express with WebSocket support
const expressApp = express();
const ws = expressWs(expressApp);
const app = ws.app;

global.isProduction = config.IS_PRODUCTION;

// Capture the exact request bytes so integrations that sign the raw payload
// (e.g. Slack's X-Slack-Signature) can verify it after body parsing. Typed with
// the node http types body-parser's `verify` hook expects.
const captureRawBody = (
  req: http.IncomingMessage,
  _res: http.ServerResponse,
  buf: Buffer,
) => {
  if (buf && buf.length) {
    (req as http.IncomingMessage & { rawBody?: Buffer }).rawBody = buf;
  }
};

const contributedRootRawRouter = express.Router();
const contributedRootRouter = express.Router();
const contributedV2Router = express.Router();
const contributedAdminRouter = express.Router();
const contributedAdminInternalRouter = express.Router();
let contributedRoutesMounted = false;

app.use(responseTime());
app.use(contributedRootRawRouter);

app.use(bodyParser.urlencoded({ extended: true, verify: captureRawBody }));
app.use(bodyParser.json({ limit: "10mb", verify: captureRawBody }));

app.use(cors()); // Add this line to enable CORS

app.disable("x-powered-by");

if (config.EXPRESS_TRUST_PROXY) {
  app.set("trust proxy", config.EXPRESS_TRUST_PROXY);
}

function attachBullBoard(serverAdapter: any) {
  const board = createBullBoard({
    queues: [new BullMQAdapter(getPrecrawlQueue())],
    serverAdapter,
  });
  bindBullBoard(queue => {
    board.addQueue(new BullMQAdapter(queue));
  });
}

if (!config.BULL_AUTH_KEY) {
  logger.warn("BULL_AUTH_KEY is not set; admin routes are disabled.");
} else {
  // A browser cannot add the Authorization header by itself; use the internal
  // listener's /admin/queues where possible.
  const opsBullBoard = new ExpressAdapter();
  opsBullBoard.setBasePath("/admin/ops/queues");
  attachBullBoard(opsBullBoard);
  app.use("/admin/ops/queues", adminAuth, opsBullBoard.getRouter());

  if (config.BULL_AUTH_KEY_PATH_ROUTES) {
    // One board per accepted key, since the UI links to its own base path.
    const pathBoards: Partial<Record<AdminKeySlot, express.Router>> = {};
    for (const [slot, key] of [
      ["current", config.BULL_AUTH_KEY],
      ["previous", config.BULL_AUTH_KEY_PREVIOUS],
    ] as const) {
      if (!key) continue;
      const board = new ExpressAdapter();
      board.setBasePath(`/admin/${encodeURIComponent(key)}/queues`);
      attachBullBoard(board);
      pathBoards[slot] = board.getRouter();
    }
    const queuesPathRouter = express.Router({ mergeParams: true });
    queuesPathRouter.use(adminPathKeyAuth("queues"), (req, res, next) =>
      pathBoards[res.locals.adminKeySlot as AdminKeySlot]!(req, res, next),
    );
    app.use("/admin/:adminKey/queues", queuesPathRouter);
  }
}

app.use(contributedRootRouter);

app.get("/", (_, res) => {
  res.json({
    message: "Firecrawl API",
    documentation_url: "https://docs.firecrawl.dev",
  });
});

app.get("/e2e-test", (_, res) => {
  res.status(200).send("OK");
});

app.get("/health/liveness", livenessController);
app.get("/health/readiness", readinessController);

// register router
app.use("/v2", contributedV2Router);
app.use("/v2", v2Router);
app.use(contributedAdminRouter);
app.use(adminRouter);

const DEFAULT_PORT = config.PORT;
const HOST = config.HOST;

// The internal listener has no key check: keep its port off public ingress.
function startAdminInternalServer(port: number) {
  const adminApp = express();
  adminApp.disable("x-powered-by");
  adminApp.use(bodyParser.json({ limit: "10mb" }));

  const internalBullBoard = new ExpressAdapter();
  internalBullBoard.setBasePath("/admin/queues");
  attachBullBoard(internalBullBoard);
  adminApp.use("/admin/queues", internalBullBoard.getRouter());

  adminApp.use(contributedAdminInternalRouter);
  adminApp.use(adminInternalRouter);
  adminApp.use(notFoundHandler);
  adminApp.use(
    (err: unknown, req: Request, res: Response, _next: NextFunction) => {
      logger.error("Internal admin request failed", {
        error: err,
        path: req.path,
      });
      res.status(500).json({ success: false, error: "Internal server error" });
    },
  );

  const host = config.ADMIN_INTERNAL_HOST;
  return adminApp.listen(port, host, (error?: Error) => {
    if (error) {
      logger.error("Failed to start internal admin server", {
        error,
        port,
        host,
      });
      throw error;
    }

    logger.info("Internal admin server listening", {
      pid: process.pid,
      port,
      host,
    });
  });
}

async function startServer(port = DEFAULT_PORT) {
  startNodeRuntimeMetrics();
  await initializeApiStartupDependencies();

  if (!contributedRoutesMounted) {
    installedService()?.mountRoutes({
      rootRaw: contributedRootRawRouter,
      root: contributedRootRouter,
      v2: contributedV2Router,
      admin: contributedAdminRouter,
      adminInternal: contributedAdminInternalRouter,
    });
    contributedRoutesMounted = true;
  }

  const server = app.listen(Number(port), HOST, (error?: Error) => {
    if (error) {
      logger.error("Failed to start HTTP server", { error, port, host: HOST });
      throw error;
    }

    logger.info(`Worker ${process.pid} listening on port ${port}`);
  });

  for (const provider of service.searchProviders.all()) {
    logger.info("Search provider registered", {
      provider: provider.name,
      priority: provider.priority,
      usOnly: provider.supportsUsOnly === true,
      zdr: provider.supportsZdr === true,
      anon: provider.supportsAnon === true,
    });
  }

  const adminInternalServer =
    config.ADMIN_INTERNAL_PORT !== undefined
      ? startAdminInternalServer(config.ADMIN_INTERNAL_PORT)
      : undefined;

  const exitHandler = async () => {
    logger.info("SIGTERM signal received: closing HTTP server");
    if (config.IS_KUBERNETES) {
      // Account for GCE load balancer drain timeout
      logger.info("Waiting 60s for GCE load balancer drain timeout");
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
    const adminInternalClosed = new Promise<void>(resolve =>
      adminInternalServer
        ? adminInternalServer.close(() => resolve())
        : resolve(),
    );
    server.close(async () => {
      await adminInternalClosed;
      logger.info("Server closed.");
      nuqShutdown().finally(() => {
        Promise.resolve()
          .then(() => installedService()?.modules.webhooks.shutdown?.())
          .catch(error => {
            logger.warn("Error shutting down webhooks module", { error });
          })
          .finally(async () => {
            try {
              await runProcessStop("api");
            } finally {
              await shutdownTracing();
            }
            logger.info("NUQ shutdown complete");
            process.exit(0);
          });
      });
    });
  };

  process.on("SIGTERM", exitHandler);
  process.on("SIGINT", exitHandler);
  return server;
}

export async function start() {
  await startServer().catch(error => {
    logger.error("Failed to start server", { error });
    process.exit(1);
  });
}

app.get("/is-production", (req, res) => {
  res.send({ isProduction: global.isProduction });
});

// Terminal handler for unmatched paths. Must stay after every route and before
// the error middleware below, or Express falls back to its default HTML page.
app.use(notFoundHandler);

app.use(
  (
    err: unknown,
    req: Request<{}, ErrorResponse, undefined>,
    res: Response<ErrorResponse>,
    next: NextFunction,
  ) => {
    if (err instanceof QueueFullError) {
      res.status(429).json({
        success: false,
        error: err.message,
      });
    } else if (err instanceof ZodError) {
      // In zod v4, ZodError uses 'issues' instead of 'errors'
      const issues = err.issues;

      if (
        Array.isArray(issues) &&
        issues.find(x => x.message === "URL uses unsupported protocol")
      ) {
        logger.warn("Unsupported protocol error: " + JSON.stringify(req.body));
      }

      // Check for unrecognized_keys errors and replace with custom message
      const hasUnrecognizedKeys = issues.some(
        e => e.code === "unrecognized_keys",
      );
      const strictMessage =
        "Unrecognized key in body -- please review the v2 API documentation for request body changes";

      const customErrorMessage = hasUnrecognizedKeys
        ? strictMessage
        : issues.length > 0 && issues[0].code === "custom"
          ? issues[0].message
          : "Bad Request";

      res.status(400).json({
        success: false,
        code: "BAD_REQUEST",
        error: customErrorMessage,
        details: issues,
      });
    } else {
      next(err);
    }
  },
);

app.use(
  (
    err: unknown,
    req: RequestWithMaybeACUC<{}, ErrorResponse, undefined>,
    res: Response<ErrorResponse>,
    next: NextFunction,
  ) => {
    if (
      err instanceof SyntaxError &&
      "status" in err &&
      err.status === 400 &&
      "body" in err
    ) {
      return res.status(400).json({
        success: false,
        code: "BAD_REQUEST_INVALID_JSON",
        error: "Bad request, malformed JSON",
      });
    }
    if (
      typeof err === "object" &&
      err !== null &&
      "status" in err &&
      (err as { status?: number }).status === 413
    ) {
      return res.status(413).json({
        success: false,
        error: "Request body is too large",
      });
    }

    const id = uuidv7();
    const path = redactAdminKey(req.path);

    logger.error(
      "Error occurred in request! (" + path + ") -- ID " + id + " -- ",
      {
        error: err,
        errorId: id,
        path,
        teamId: req.acuc?.team_id,
        team_id: req.acuc?.team_id,
      },
    );
    res.status(500).json({
      success: false,
      code: "UNKNOWN_ERROR",
      error: service.modules.messages.errorContact(id),
    });
  },
);

logger.info(`Worker ${process.pid} started`);

if (require.main === module) {
  void startRole("api");
}
