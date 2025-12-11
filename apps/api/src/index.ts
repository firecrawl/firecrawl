import "dotenv/config";
import { config } from "./config";
import "./services/sentry";
import { setSentryServiceTag } from "./services/sentry";
import * as Sentry from "@sentry/node";
import express, { NextFunction, Request, Response } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import {
  getExtractQueue,
  getGenerateLlmsTxtQueue,
  getDeepResearchQueue,
  getBillingQueue,
  getPrecrawlQueue,
} from "./services/queue-service";
import { v0Router } from "./routes/v0";
import os from "os";
import { logger } from "./lib/logger";
import { adminRouter } from "./routes/admin";
import http from "node:http";
import https from "node:https";
import { v1Router } from "./routes/v1";
import expressWs from "express-ws";
import {
  ErrorResponse,
  RequestWithMaybeACUC,
  ResponseWithSentry,
} from "./controllers/v1/types";
import { ZodError } from "zod";
import { v7 as uuidv7 } from "uuid";
import { attachWsProxy } from "./services/agentLivecastWS";
import { cacheableLookup } from "./scraper/scrapeURL/lib/cacheableLookup";
import { v2Router } from "./routes/v2";
import domainFrequencyRouter from "./routes/domain-frequency";
import { nuqShutdown } from "./services/worker/nuq";
import { getErrorContactMessage } from "./lib/deployment";
import { initializeBlocklist } from "./scraper/WebScraper/utils/blocklist";
import { initializeEngineForcing } from "./scraper/WebScraper/utils/engine-forcing";
import responseTime from "response-time";

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

setSentryServiceTag("api");

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: "10mb" }));

app.use(cors()); // Add this line to enable CORS

app.use(responseTime());

app.disable("x-powered-by");

if (config.EXPRESS_TRUST_PROXY) {
  app.set("trust proxy", config.EXPRESS_TRUST_PROXY);
}

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath(`/admin/${config.BULL_AUTH_KEY}/queues`);

const { addQueue, removeQueue, setQueues, replaceQueues } = createBullBoard({
  queues: [
    new BullMQAdapter(getExtractQueue()),
    new BullMQAdapter(getGenerateLlmsTxtQueue()),
    new BullMQAdapter(getDeepResearchQueue()),
    new BullMQAdapter(getBillingQueue()),
    new BullMQAdapter(getPrecrawlQueue()),
  ],
  serverAdapter: serverAdapter,
});

app.use(`/admin/${config.BULL_AUTH_KEY}/queues`, serverAdapter.getRouter());

app.get("/", (_, res) => {
  res.redirect("https://docs.firecrawl.dev/api-reference/v2-introduction");
});

app.get("/e2e-test", (_, res) => {
  res.status(200).send("OK");
});

// register router
app.use(v0Router);
app.use("/v1", v1Router);
app.use("/v2", v2Router);
app.use(adminRouter);
app.use(domainFrequencyRouter);

const DEFAULT_PORT = config.PORT;
const HOST = config.HOST;

async function startServer(port = DEFAULT_PORT) {
  try {
    await initializeBlocklist();
    initializeEngineForcing();
  } catch (error) {
    logger.error("Failed to initialize blocklist and engine forcing", {
      error,
    });
    throw error;
  }

  // Attach WebSocket proxy to the Express app
  attachWsProxy(app);

  const server = app.listen(Number(port), HOST, () => {
    logger.info(`Worker ${process.pid} listening on port ${port}`);
  });

  const exitHandler = async () => {
    logger.info("SIGTERM signal received: closing HTTP server");
    if (config.IS_KUBERNETES) {
      // Account for GCE load balancer drain timeout
      logger.info("Waiting 60s for GCE load balancer drain timeout");
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
    server.close(() => {
      logger.info("Server closed.");
      nuqShutdown().finally(() => {
        logger.info("NUQ shutdown complete");
        process.exit(0);
      });
    });
  };

  process.on("SIGTERM", exitHandler);
  process.on("SIGINT", exitHandler);
  return server;
}

if (require.main === module) {
  startServer().catch(error => {
    logger.error("Failed to start server", { error });
    process.exit(1);
  });
}

app.get("/is-production", (req, res) => {
  res.send({ isProduction: global.isProduction });
});

app.use(
  (
    err: unknown,
    req: Request<{}, ErrorResponse, undefined>,
    res: Response<ErrorResponse>,
    next: NextFunction,
  ) => {
    if (err instanceof ZodError) {
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

Sentry.setupExpressErrorHandler(app);

app.use(
  (
    err: unknown,
    req: RequestWithMaybeACUC<{}, ErrorResponse, undefined>,
    res: ResponseWithSentry<ErrorResponse>,
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

    const id = res.sentry ?? uuidv7();

    logger.error(
      "Error occurred in request! (" + req.path + ") -- ID " + id + " -- ",
      {
        error: err,
        errorId: id,
        path: req.path,
        teamId: req.acuc?.team_id,
        team_id: req.acuc?.team_id,
      },
    );
    res.status(500).json({
      success: false,
      code: "UNKNOWN_ERROR",
      error: getErrorContactMessage(id),
    });
  },
);

logger.info(`Worker ${process.pid} started`);
