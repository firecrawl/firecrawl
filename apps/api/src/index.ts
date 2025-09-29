import "dotenv/config";
import { shutdownOtel } from "./otel";
import "./services/sentry";
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
import { v4 as uuidv4 } from "uuid";
import { attachWsProxy } from "./services/agentLivecastWS";
import { cacheableLookup } from "./scraper/scrapeURL/lib/cacheableLookup";
import { v2Router } from "./routes/v2";
import domainFrequencyRouter from "./routes/domain-frequency";
import { nuqShutdown } from "./services/worker/nuq";
import { getErrorContactMessage } from "./lib/deployment";
import { initializeBlocklist } from "./scraper/WebScraper/utils/blocklist";
import responseTime from "response-time";

const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { ExpressAdapter } = require("@bull-board/express");

const numCPUs = process.env.ENV === "local" ? 2 : os.cpus().length;
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

global.isProduction = process.env.IS_PRODUCTION === "true";

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: "10mb" }));

app.use(cors()); // Add this line to enable CORS

app.use(responseTime());

if (process.env.EXPRESS_TRUST_PROXY) {
  app.set("trust proxy", parseInt(process.env.EXPRESS_TRUST_PROXY, 10));
}

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath(`/admin/${process.env.BULL_AUTH_KEY}/queues`);

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

app.use(
  `/admin/${process.env.BULL_AUTH_KEY}/queues`,
  serverAdapter.getRouter(),
);

app.get("/", (req, res) => {
  res.send("SCRAPERS-JS: Hello, world! K8s!");
});

//write a simple test function
app.get("/test", async (req, res) => {
  res.send("Hello, world!");
});

// register router
app.use(v0Router);
app.use("/v1", v1Router);
app.use("/v2", v2Router);
app.use(adminRouter);
app.use(domainFrequencyRouter);

const DEFAULT_PORT = process.env.PORT ?? 3002;
const HOST = process.env.HOST ?? "localhost";

async function startServer(port = DEFAULT_PORT) {
  try {
    await initializeBlocklist();
  } catch (error) {
    logger.error("Failed to initialize blocklist", { error });
    throw error;
  }

  // Attach WebSocket proxy to the Express app
  attachWsProxy(app);

  const server = app.listen(Number(port), HOST, () => {
    logger.info(`Worker ${process.pid} listening on port ${port}`);
  });

  const exitHandler = async () => {
    logger.info("SIGTERM signal received: closing HTTP server");
    if (process.env.IS_KUBERNETES === "true") {
      // Account for GCE load balancer drain timeout
      logger.info("Waiting 60s for GCE load balancer drain timeout");
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
    server.close(() => {
      logger.info("Server closed.");
      nuqShutdown().finally(() => {
        logger.info("NUQ shutdown complete");
        shutdownOtel().finally(() => {
          logger.info("OTEL shutdown");
          process.exit(0);
        });
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
      if (
        Array.isArray(err.errors) &&
        err.errors.find(x => x.message === "URL uses unsupported protocol")
      ) {
        logger.warn("Unsupported protocol error: " + JSON.stringify(req.body));
      }

      const customErrorMessage =
        err.errors.length > 0 && err.errors[0].code === "custom"
          ? err.errors[0].message
          : "Bad Request";

      res.status(400).json({
        success: false,
        code: "BAD_REQUEST",
        error: customErrorMessage,
        details: err.errors,
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

    const id = res.sentry ?? uuidv4();

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
