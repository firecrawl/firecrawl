import "dotenv/config";
import "./services/sentry";
import * as Sentry from "@sentry/node";
import express, { NextFunction, Request, Response } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import {
  getExtractQueue,
  getScrapeQueue,
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
import { ErrorResponse, RequestWithMaybeACUC, ResponseWithSentry } from "./controllers/v1/types";
import { ZodError } from "zod";
import { v4 as uuidv4 } from "uuid";
import { RateLimiterMode } from "./types";
import { attachWsProxy } from "./services/agentLivecastWS";
import { cacheableLookup } from "./scraper/scrapeURL/lib/cacheableLookup";
import { v2Router } from "./routes/v2";
import domainFrequencyRouter from "./routes/domain-frequency";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseExporter } from "langfuse-vercel";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";

const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require("@bull-board/express");

const numCPUs = process.env.ENV === "local" ? 2 : os.cpus().length;
logger.info(`Number of CPUs: ${numCPUs} available`);

logger.info("Network info dump", {
  networkInterfaces: os.networkInterfaces(),
});

// Install cacheable lookup for all other requests
cacheableLookup.install(http.globalAgent);
cacheableLookup.install(https.globalAgent);

const shouldOtel = process.env.LANGFUSE_PUBLIC_KEY || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const otelSdk = shouldOtel ? new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "firecrawl-app",
  }),
  spanProcessors: [
    ...(process.env.LANGFUSE_PUBLIC_KEY ? [new BatchSpanProcessor(new LangfuseExporter())] : []),
    ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? [new BatchSpanProcessor(new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    }))] : []),
  ],
  instrumentations: [getNodeAutoInstrumentations()],
}) : null;
    
if (otelSdk) {   
  otelSdk.start();
}

// Initialize Express with WebSocket support
const expressApp = express();
const ws = expressWs(expressApp);
const app = ws.app;

global.isProduction = process.env.IS_PRODUCTION === "true";

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: "10mb" }));

app.use(cors()); // Add this line to enable CORS

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath(`/admin/${process.env.BULL_AUTH_KEY}/queues`);

const { addQueue, removeQueue, setQueues, replaceQueues } = createBullBoard({
  queues: [
    new BullMQAdapter(getScrapeQueue()),
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

function startServer(port = DEFAULT_PORT) {
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
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }
    server.close(() => {
      logger.info("Server closed.");
      if (otelSdk) {
        otelSdk.shutdown().then(() => {
          logger.info("OTEL shutdown");
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
  };

  process.on("SIGTERM", exitHandler);
  process.on("SIGINT", exitHandler);
  return server;
}

if (require.main === module) {
  startServer();
}

app.get(`/serverHealthCheck`, async (req, res) => {
  try {
    const scrapeQueue = getScrapeQueue();
    const [waitingJobs] = await Promise.all([scrapeQueue.getWaitingCount()]);
    const noWaitingJobs = waitingJobs === 0;
    // 200 if no active jobs, 503 if there are active jobs
    return res.status(noWaitingJobs ? 200 : 500).json({
      waitingJobs,
    });
  } catch (error) {
    Sentry.captureException(error);
    logger.error(error);
    return res.status(500).json({ error: error.message });
  }
});

app.get("/serverHealthCheck/notify", async (req, res) => {
  if (process.env.SLACK_WEBHOOK_URL) {
    const treshold = 1; // The treshold value for the active jobs
    const timeout = 60000; // 1 minute // The timeout value for the check in milliseconds

    const getWaitingJobsCount = async () => {
      const scrapeQueue = getScrapeQueue();
      const [waitingJobsCount] = await Promise.all([
        scrapeQueue.getWaitingCount(),
      ]);

      return waitingJobsCount;
    };

    res.status(200).json({ message: "Check initiated" });

    const checkWaitingJobs = async () => {
      try {
        let waitingJobsCount = await getWaitingJobsCount();
        if (waitingJobsCount >= treshold) {
          setTimeout(async () => {
            // Re-check the waiting jobs count after the timeout
            waitingJobsCount = await getWaitingJobsCount();
            if (waitingJobsCount >= treshold) {
              const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL!;
              const message = {
                text: `⚠️ Warning: The number of active jobs (${waitingJobsCount}) has exceeded the threshold (${treshold}) for more than ${
                  timeout / 60000
                } minute(s).`,
              };

              const response = await fetch(slackWebhookUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(message),
              });

              if (!response.ok) {
                logger.error("Failed to send Slack notification");
              }
            }
          }, timeout);
        }
      } catch (error) {
        Sentry.captureException(error);
        logger.debug(error);
      }
    };

    checkWaitingJobs();
  }
});

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
        err.errors.find((x) => x.message === "URL uses unsupported protocol")
      ) {
        logger.warn("Unsupported protocol error: " + JSON.stringify(req.body));
      }

      res
        .status(400)
        .json({ success: false, code: "BAD_REQUEST", error: "Bad Request", details: err.errors });
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
      return res
        .status(400)
        .json({ success: false, code: "BAD_REQUEST_INVALID_JSON", error: "Bad request, malformed JSON" });
    }

    const id = res.sentry ?? uuidv4();

    logger.error(
      "Error occurred in request! (" +
        req.path +
        ") -- ID " +
        id +
        " -- ",
    { error: err, errorId: id, path: req.path, teamId: req.acuc?.team_id, team_id: req.acuc?.team_id });
    res.status(500).json({
      success: false,
      code: "UNKNOWN_ERROR",
      error:
        "An unexpected error occurred. Please contact help@firecrawl.com for help. Your exception ID is " +
        id,
    });
  },
);

logger.info(`Worker ${process.pid} started`);
// const sq = getScrapeQueue();

// sq.on("waiting", j => ScrapeEvents.logJobEvent(j, "waiting"));
// sq.on("active", j => ScrapeEvents.logJobEvent(j, "active"));
// sq.on("completed", j => ScrapeEvents.logJobEvent(j, "completed"));
// sq.on("paused", j => ScrapeEvents.logJobEvent(j, "paused"));
// sq.on("resumed", j => ScrapeEvents.logJobEvent(j, "resumed"));
// sq.on("removed", j => ScrapeEvents.logJobEvent(j, "removed"));
// 
