import type { Logger } from "winston";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { Client, Pool } from "pg";
import type { Document } from "../../controllers/v2/types";
import { jsonValueSchema } from "../../lib/json-types";
import type { JsonValue } from "../../lib/json-types";
import type { ScrapeJobData } from "../../types";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import { storedZeroDataRetention } from "../../lib/request-context";
import { safeParseLogged } from "../../lib/zod-log";
import amqp from "amqplib";
import { normalizeOwnerId } from "../../lib/owner-id";
import { config } from "../../config";
import { decodeScrapeJobData, decodeScrapeReturnValue } from "./nuq-decoders";
import { nuqRedis } from "./redis";

// === Basics

const nuqPool = new Pool({
  connectionString: config.NUQ_DATABASE_URL, // may be a pgbouncer transaction pooler URL
  application_name: "nuq",
});

nuqPool.on("error", err =>
  logger.error("Error in NuQ idle client", { err, module: "nuq" }),
);

const nuqJobStatusSchema = z.enum([
  "queued",
  "active",
  "completed",
  "failed",
  "backlog",
]);

export type NuQJobStatus = z.infer<typeof nuqJobStatusSchema>;

const terminalJobStatusSchema = z.enum(["completed", "failed"]);

const stringSchema = z.string();
const timestampLikeSchema = z.union([z.string(), z.number()]);

const rabbitJobEnvelopeSchema = z.object({
  id: z.string(),
  status: nuqJobStatusSchema,
  createdAt: timestampLikeSchema,
  priority: z.number(),
  data: z.unknown(),
  finishedAt: z.unknown().optional(),
  listenChannelId: z.unknown().optional(),
  returnvalue: z.unknown().optional(),
  failedReason: z.unknown().optional(),
  lock: z.unknown().optional(),
  ownerId: z.unknown().optional(),
  groupId: z.unknown().optional(),
});

function optionalString(value: unknown, tag?: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed =
    tag !== undefined
      ? safeParseLogged(stringSchema, value, tag)
      : stringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function optionalDate(value: unknown, tag: string): Date | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = safeParseLogged(timestampLikeSchema, value, tag);
  return parsed.success ? new Date(parsed.data) : undefined;
}

function decodeJsonValue(raw: unknown): JsonValue {
  if (raw === undefined) {
    return null;
  }
  const parsed = safeParseLogged(jsonValueSchema, raw, "nuq.jsonValue");
  return parsed.success ? parsed.data : null;
}

export type NuQJob<Data = unknown, ReturnValue = unknown> = {
  id: string;
  status: NuQJobStatus;
  createdAt: Date;
  priority: number;
  data: Data;
  finishedAt?: Date;
  listenChannelId?: string;
  returnvalue?: ReturnValue;
  failedReason?: string;
  lock?: string;
  ownerId?: string;
  groupId?: string;
};

type NuQJobOptions = {
  priority?: number;
  listenable?: boolean;
  ownerId?: string;
  groupId?: string;
  backlogged?: boolean;
  backloggedTimesOutAt?: Date;
};

type NuQOptions<JobData, JobReturnValue> = {
  backlog?: boolean;
  decodeData: (raw: unknown) => JobData;
  decodeReturnvalue: (raw: unknown) => JobReturnValue;
};

type JobRow<JobData, _JobReturnValue = unknown> = {
  id: string;
  status?: NuQJobStatus;
  created_at: string | Date;
  priority: number;
  data: JobData;
  finished_at?: string | Date | null;
  listen_channel_id?: string | null;
  returnvalue?: unknown;
  failedreason?: string | null;
  lock?: string | null;
  owner_id?: string | null;
  group_id?: string | null;
};

type LockRow = {
  lock: string;
};

type StatusCountRow = {
  status: string;
  count: string;
};

type OwnerIdRow = {
  owner_id: string;
};

type IdRow = {
  id: string;
};

type JobSignalRow = {
  id: string;
  listen_channel_id: string | null;
};

type GroupRow = {
  id: string;
  status: NuQGroupStatus;
  created_at: string | Date;
  owner_id: string;
  ttl: number;
  expires_at: string | Date | null;
};

function isExpectedAmqpCloseError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String(error.message)
        : typeof error === "string"
          ? error
          : "";

  return (
    message === "Connection closing" ||
    message === "Connection closed" ||
    message === "Channel closing" ||
    message === "Channel closed"
  );
}

async function closeAmqpResource<T>(
  close: () => Promise<T>,
  resource: string,
): Promise<void> {
  try {
    await close();
  } catch (error: unknown) {
    if (isExpectedAmqpCloseError(error)) {
      logger.info(`NuQ ${resource} already closing during shutdown`, {
        module: "nuq/rabbitmq",
      });
      return;
    }

    throw error;
  }
}

// === Queue

class NuQ<JobData = JsonValue, JobReturnValue = JsonValue> {
  private listenChannelId: string =
    config.NUQ_POD_NAME + "-" + crypto.randomUUID();

  constructor(
    public readonly queueName: string,
    public readonly options: NuQOptions<JobData, JobReturnValue>,
  ) {}

  // === Listener

  private listener:
    | {
        type: "postgres";
        client: Client;
      }
    | {
        type: "rabbitmq";
        connection: amqp.ChannelModel;
        channel: amqp.Channel;
        queue: string;
      }
    | null = null;
  private listens: {
    [key: string]: Array<(status: "completed" | "failed") => void>;
  } = {};
  private listenerStarting = false;
  private shuttingDown = false;

  private async startListener() {
    if (this.listener || this.shuttingDown || this.listenerStarting) {
      return;
    }

    if (config.NUQ_RABBITMQ_URL) {
      this.listenerStarting = true;

      try {
        const connection = await amqp.connect(config.NUQ_RABBITMQ_URL);
        connection.on("error", (err: unknown) => {
          logger.error("NuQ listener connection error", {
            module: "nuq/rabbitmq",
            err,
          });
        });
        const channel = await connection.createChannel();
        channel.on("error", (err: unknown) => {
          logger.error("NuQ listener channel error", {
            module: "nuq/rabbitmq",
            err,
          });
        });
        await channel.prefetch(5);
        const queue = await channel.assertQueue(
          this.queueName + ".listen." + this.listenChannelId,
          {
            exclusive: true,
            autoDelete: true,
            durable: false,
            arguments: {
              "x-queue-type": "classic",
              "x-message-ttl": 60_000,
            },
          },
        );

        this.listener = {
          type: "rabbitmq",
          connection,
          channel,
          queue: queue.queue,
        };
      } finally {
        this.listenerStarting = false;
      }

      let reconnectTimeout: NodeJS.Timeout | null = null;

      const onClose = () => {
        logger.info("NuQ listener channel closed", {
          module: "nuq/rabbitmq",
        });
        this.listener = null;

        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
        }
        reconnectTimeout = setTimeout(() => {
          this.startListener().catch((error: unknown) =>
            logger.error("Error in NuQ listener reconnect", {
              err: error,
              module: "nuq/rabbitmq",
            }),
          );
        }, 250);
      };

      this.listener.connection.on("close", onClose);
      this.listener.channel.on("close", onClose);

      await this.listener.channel.consume(
        this.listener.queue,
        msg => {
          if (msg === null) {
            onClose();
            return;
          }

          const rawJobId: unknown = msg.properties.correlationId;
          const rawStatus = msg.content.toString();

          logger.info("NuQ job received", {
            module: "nuq/rabbitmq",
            jobId: rawJobId,
            status: rawStatus,
          });

          const parsedStatus = safeParseLogged(
            terminalJobStatusSchema,
            rawStatus,
            "nuq.rabbit.listenStatus",
          );
          if (typeof rawJobId === "string" && parsedStatus.success) {
            if (rawJobId in this.listens) {
              this.listens[rawJobId].forEach(listener =>
                listener(parsedStatus.data),
              );
            }
            delete this.listens[rawJobId];
          }

          if (this.listener && this.listener.type === "rabbitmq") {
            this.listener.channel.ack(msg);
          }
        },
        {
          noAck: false,
        },
      );
    } else {
      this.listenerStarting = true;

      try {
        this.listener = {
          type: "postgres",
          client: new Client({
            connectionString:
              config.NUQ_DATABASE_URL_LISTEN ?? config.NUQ_DATABASE_URL, // will always be a direct connection
            application_name: "nuq_listener",
          }),
        };

        let reconnectTimeout: NodeJS.Timeout | null = null;

        this.listener.client.on("notification", msg => {
          const tok = (msg.payload ?? "unknown|unknown").split("|");
          const jobId = tok[0];
          const status = tok[1];
          const parsedStatus = safeParseLogged(
            terminalJobStatusSchema,
            status,
            "nuq.pg.listenStatus",
          );
          if (jobId in this.listens && parsedStatus.success) {
            this.listens[jobId].forEach(listener =>
              listener(parsedStatus.data),
            );
            delete this.listens[jobId];
          }
        });

        this.listener.client.on("error", err => {
          logger.error("Error in NuQ listener", { err, module: "nuq" });
          // Trigger cleanup and reconnection on error
          if (this.listener && this.listener.type === "postgres") {
            const nl = this.listener;
            this.listener = null;
            nl.client.end().catch(() => {});
            if (reconnectTimeout) {
              clearTimeout(reconnectTimeout);
            }
            reconnectTimeout = setTimeout(() => {
              this.startListener().catch((error: unknown) =>
                logger.error("Error in NuQ listener reconnect", {
                  err: error,
                  module: "nuq",
                }),
              );
            }, 250);
          }
        });

        this.listener.client.on("end", () => {
          logger.info("NuQ listener disconnected", { module: "nuq" });
          this.listener = null;

          if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
          }
          reconnectTimeout = setTimeout(() => {
            this.startListener().catch((error: unknown) =>
              logger.error("Error in NuQ listener reconnect", {
                err: error,
                module: "nuq",
              }),
            );
          }, 250);
        });

        await this.listener.client.connect();
        await this.listener.client.query(`LISTEN "${this.queueName}";`);
      } finally {
        this.listenerStarting = false;
      }
    }

    void (async () => {
      const backedUpJobs = (
        await this.getJobs(Object.keys(this.listens))
      ).filter(job => job.status === "completed" || job.status === "failed");
      for (const job of backedUpJobs) {
        if (job.status !== "completed" && job.status !== "failed") {
          continue;
        }
        const status = job.status;
        if (job.id in this.listens) {
          this.listens[job.id].forEach(listener => listener(status));
          delete this.listens[job.id];
        }
      }
    })();
  }

  private async addListener(
    id: string,
    listener: (status: "completed" | "failed") => void,
  ) {
    await this.startListener();

    if (!(id in this.listens)) {
      this.listens[id] = [listener];
    } else {
      this.listens[id].push(listener);
    }
  }

  private removeListener(
    id: string,
    listener: (status: "completed" | "failed") => void,
  ) {
    if (id in this.listens) {
      this.listens[id] = this.listens[id].filter(l => l !== listener);
      if (this.listens[id].length === 0) {
        delete this.listens[id];
      }
    }
  }

  // === Sender

  private sender: {
    type: "rabbitmq";
    connection: amqp.ChannelModel;
    channel: amqp.Channel;
  } | null = null;
  private senderStarting = false;

  private async startSender() {
    if (this.sender || this.shuttingDown || this.senderStarting) {
      return;
    }
    this.senderStarting = true;

    try {
      if (config.NUQ_RABBITMQ_URL) {
        const connection = await amqp.connect(config.NUQ_RABBITMQ_URL);
        const channel = await connection.createChannel();
        await channel.assertQueue(this.queueName + ".prefetch", {
          durable: true,
          arguments: {
            "x-queue-type": "quorum",
            "x-max-length": 20_000,
          },
        });

        this.sender = {
          type: "rabbitmq",
          connection,
          channel,
        };

        channel.on("close", () => {
          logger.info("NuQ sender channel closed", { module: "nuq/rabbitmq" });
          if (!this.shuttingDown) {
            connection.close().catch(() => {});
          }
          this.sender = null;
        });

        channel.on("error", (err: unknown) => {
          logger.error("NuQ sender channel error", {
            module: "nuq/rabbitmq",
            err,
          });
        });

        connection.on("close", () => {
          logger.info("NuQ sender connection closed", {
            module: "nuq/rabbitmq",
          });
          this.sender = null;
        });

        connection.on("error", (err: unknown) => {
          logger.error("NuQ sender connection error", {
            module: "nuq/rabbitmq",
            err,
          });
        });
      }
    } finally {
      this.senderStarting = false;
    }
  }

  private async sendJobEnd(
    id: string,
    status: "completed" | "failed",
    listenChannelId: string,
    _logger: Logger = logger,
  ) {
    await this.startSender();

    if (this.sender) {
      this.sender.channel.sendToQueue(
        this.queueName + ".listen." + listenChannelId,
        Buffer.from(status, "utf8"),
        {
          correlationId: id,
        },
      );
      _logger.info("NuQ job sent", { module: "nuq/rabbitmq" });
    } else {
      _logger.warn("NuQ sender not started", { module: "nuq/rabbitmq" });
    }
  }

  private async sendJobPrefetch(
    job: NuQJob<JobData, JobReturnValue>,
    _logger: Logger = logger,
  ) {
    await this.startSender();

    if (this.sender) {
      this.sender.channel.sendToQueue(
        this.queueName + ".prefetch",
        Buffer.from(JSON.stringify(job), "utf8"),
        {
          correlationId: job.id,
          persistent: true,
          expiration: "50000", // must be less than lock reaper timeout (1 min) to minimize dead zone where jobs are expired from RabbitMQ but still "active" in DB
        },
      );
      _logger.info("NuQ job prefetch sent", { module: "nuq/rabbitmq" });
    } else {
      _logger.warn("NuQ sender not started", { module: "nuq/rabbitmq" });
    }
  }

  // === Job management

  private readonly jobReturning = [
    "id",
    "status",
    "created_at",
    "priority",
    "data",
    "finished_at",
    "listen_channel_id",
    "returnvalue",
    "failedreason",
    "lock",
    "owner_id",
    "group_id",
  ];

  private readonly jobBacklogReturning = [
    "id",
    "created_at",
    "priority",
    "data",
    "listen_channel_id",
    "owner_id",
    "group_id",
  ];

  private rowToJob(
    row: JobRow<JobData, JobReturnValue>,
    backlogged?: boolean,
  ): NuQJob<JobData, JobReturnValue> {
    let returnvalue: JobReturnValue | undefined = undefined;
    if (row.returnvalue !== undefined && row.returnvalue !== null) {
      try {
        returnvalue = this.options.decodeReturnvalue(row.returnvalue);
      } catch (error: unknown) {
        const zdr =
          row.data === null || row.data === undefined
            ? undefined
            : storedZeroDataRetention(row.data);
        logger.error(
          "Failed to decode NuQ job returnvalue",
          zdr === undefined
            ? {
                queueName: this.queueName,
                error,
              }
            : {
                queueName: this.queueName,
                jobId: row.id,
                zeroDataRetention: zdr,
                error,
              },
        );
      }
    }
    return {
      id: row.id,
      status: backlogged ? "backlog" : (row.status ?? "queued"),
      createdAt: new Date(row.created_at),
      priority: row.priority,
      data: row.data,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
      listenChannelId: row.listen_channel_id ?? undefined,
      returnvalue,
      failedReason: row.failedreason ?? undefined,
      lock: row.lock ?? undefined,
      ownerId: row.owner_id ?? undefined,
      groupId: row.group_id ?? undefined,
    };
  }

  private maybeRowToJob(
    row: JobRow<JobData, JobReturnValue> | undefined,
    backlogged?: boolean,
  ): NuQJob<JobData, JobReturnValue> | null {
    return row ? this.rowToJob(row, backlogged) : null;
  }

  // RabbitMQ payloads are already-mapped NuQJobs (camelCase) that have been
  // serialized to JSON, so dates arrive as strings. Revive them here instead
  // of running the payload back through rowToJob (which expects raw DB rows).
  private rabbitRowToJob(raw: unknown): NuQJob<JobData, JobReturnValue> | null {
    const parsed = safeParseLogged(
      rabbitJobEnvelopeSchema,
      raw,
      "nuq.rabbit.jobEnvelope",
    );
    if (!parsed.success) {
      return null;
    }
    const row = parsed.data;
    return {
      id: row.id,
      status: row.status,
      createdAt: new Date(row.createdAt),
      priority: row.priority,
      data: this.options.decodeData(row.data),
      finishedAt: optionalDate(row.finishedAt, "nuq.rabbit.finishedAt"),
      listenChannelId: optionalString(
        row.listenChannelId,
        "nuq.rabbit.listenChannelId",
      ),
      returnvalue:
        row.returnvalue !== undefined && row.returnvalue !== null
          ? this.options.decodeReturnvalue(row.returnvalue)
          : undefined,
      failedReason: optionalString(row.failedReason, "nuq.rabbit.failedReason"),
      lock: optionalString(row.lock, "nuq.rabbit.lock"),
      ownerId: optionalString(row.ownerId, "nuq.rabbit.ownerId"),
      groupId: optionalString(row.groupId, "nuq.rabbit.groupId"),
    };
  }

  public async getJob(
    id: string,
    _logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue> | null> {
    return withSpan("nuq.getJob", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
      });

      const start = Date.now();
      try {
        const result = this.maybeRowToJob(
          (
            await nuqPool.query<JobRow<JobData, JobReturnValue>>(
              `SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.id = $1;`,
              [id],
            )
          ).rows[0],
        );

        setSpanAttributes(span, {
          "nuq.job_found": result !== null,
          "nuq.job_status": result?.status,
        });

        return result;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        _logger.info("nuqGetJob metrics", {
          module: "nuq/metrics",
          method: "nuqGetJob",
          duration,
          scrapeId: id,
        });
      }
    });
  }

  public async getJobs(
    ids: Array<string>,
    _logger: Logger = logger,
  ): Promise<Array<NuQJob<JobData, JobReturnValue>>> {
    if (ids.length === 0) {
      return [];
    }

    const start = Date.now();
    try {
      return (
        await nuqPool.query<JobRow<JobData, JobReturnValue>>(
          `SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.id = ANY($1::uuid[]);`,
          [ids],
        )
      ).rows.map(row => this.rowToJob(row));
    } finally {
      _logger.info("nuqGetJobs metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobs",
        duration: Date.now() - start,
        scrapeIds: ids.length,
      });
    }
  }

  public async getJobsFromBacklog(
    ids: Array<string>,
    _logger: Logger = logger,
  ): Promise<Array<NuQJob<JobData, JobReturnValue>>> {
    if (ids.length === 0) {
      return [];
    }

    const start = Date.now();
    try {
      return (
        await nuqPool.query<JobRow<JobData, JobReturnValue>>(
          `SELECT ${this.jobBacklogReturning.join(", ")} FROM ${this.queueName}_backlog WHERE ${this.queueName}_backlog.id = ANY($1::uuid[]);`,
          [ids],
        )
      ).rows.map(row => this.rowToJob(row, true));
    } finally {
      _logger.info("nuqGetJobsFromBacklog metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobsFromBacklog",
        duration: Date.now() - start,
        scrapeIds: ids.length,
      });
    }
  }

  public async getJobsWithStatus(
    ids: Array<string>,
    status: NuQJobStatus,
    _logger: Logger = logger,
  ): Promise<Array<NuQJob<JobData, JobReturnValue>>> {
    if (ids.length === 0) {
      return [];
    }

    const start = Date.now();
    try {
      return (
        await nuqPool.query<JobRow<JobData, JobReturnValue>>(
          `SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.id = ANY($1::uuid[]) AND ${this.queueName}.status = $2::nuq.job_status;`,
          [ids, status],
        )
      ).rows.map(row => this.rowToJob(row));
    } finally {
      _logger.info("nuqGetJobsWithStatus metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobsWithStatus",
        duration: Date.now() - start,
        scrapeIds: ids.length,
        status,
      });
    }
  }

  public async getJobsWithStatuses(
    ids: Array<string>,
    statuses: Array<NuQJobStatus>,
    _logger: Logger = logger,
  ): Promise<Array<NuQJob<JobData, JobReturnValue>>> {
    if (ids.length === 0) {
      return [];
    }

    const start = Date.now();
    try {
      return (
        await nuqPool.query<JobRow<JobData, JobReturnValue>>(
          `SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.id = ANY($1::uuid[]) AND ${this.queueName}.status = ANY($2::nuq.job_status[]);`,
          [ids, statuses],
        )
      ).rows.map(row => this.rowToJob(row));
    } finally {
      _logger.info("nuqGetJobsWithStatuses metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobsWithStatuses",
        duration: Date.now() - start,
        scrapeIds: ids.length,
        statuses,
      });
    }
  }

  public async getGroupAnyJob(
    groupId: string,
    ownerId: string,
  ): Promise<NuQJob<JobData, JobReturnValue> | null> {
    return this.maybeRowToJob(
      (
        await nuqPool.query<JobRow<JobData, JobReturnValue>>(
          `
            SELECT ${this.jobReturning.join(", ")}
            FROM ${this.queueName}
            WHERE ${this.queueName}.group_id = $1
              AND ${this.queueName}.owner_id = $2
              AND ${this.queueName}.data->>'mode' = 'single_urls'
            LIMIT 1;
          `,
          [groupId, normalizeOwnerId(ownerId)],
        )
      ).rows[0],
    );
  }

  public async getGroupNumericStats(
    groupId: string,
    _logger: Logger = logger,
  ): Promise<Record<NuQJobStatus, number>> {
    const start = Date.now();
    try {
      const { rows } = await nuqPool.query<StatusCountRow>(
        `
          SELECT ${this.queueName}.status::text as status, COUNT(*) as count
          FROM ${this.queueName}
          WHERE ${this.queueName}.group_id = $1
          AND ${this.queueName}.data->>'mode' = 'single_urls'
          GROUP BY ${this.queueName}.status
          UNION ALL
          SELECT 'backlog'::text as status, COUNT(*) as count
          FROM ${this.queueName}_backlog
          WHERE ${this.queueName}_backlog.group_id = $1
          AND ${this.queueName}_backlog.data->>'mode' = 'single_urls'
        `,
        [groupId],
      );
      const stats: Record<NuQJobStatus, number> = {
        queued: 0,
        active: 0,
        completed: 0,
        failed: 0,
        backlog: 0,
      };
      for (const row of rows) {
        const parsedStatus = safeParseLogged(
          nuqJobStatusSchema,
          row.status,
          "nuq.pg.groupNumericStatsStatus",
        );
        if (parsedStatus.success) {
          stats[parsedStatus.data] = Number.parseInt(row.count, 10);
        }
      }
      return stats;
    } finally {
      _logger.info("nuqGetGroupNumericStats metrics", {
        module: "nuq/metrics",
        method: "nuqGetGroupNumericStats",
        duration: Date.now() - start,
        crawlId: groupId,
      });
    }
  }

  public async getBackloggedOwnerIDs(
    _logger: Logger = logger,
  ): Promise<Array<string>> {
    const start = Date.now();
    try {
      return (
        await nuqPool.query<OwnerIdRow>(
          `SELECT DISTINCT owner_id FROM ${this.queueName}_backlog;`,
        )
      ).rows.map(row => row.owner_id);
    } finally {
      _logger.info("nuqGetBackloggedOwnerIDs metrics", {
        module: "nuq/metrics",
        method: "nuqGetBackloggedOwnerIDs",
        duration: Date.now() - start,
      });
    }
  }

  public async getBackloggedJobIDsOfOwner(
    ownerId: string,
    _logger: Logger = logger,
  ): Promise<Array<string>> {
    const start = Date.now();
    try {
      return (
        await nuqPool.query<IdRow>(
          `SELECT id FROM ${this.queueName}_backlog WHERE owner_id = $1;`,
          [ownerId],
        )
      ).rows.map(row => row.id);
    } finally {
      _logger.info("nuqGetBackloggedJobIDsOfOwner metrics", {
        module: "nuq/metrics",
        method: "nuqGetBackloggedJobIDsOfOwner",
        duration: Date.now() - start,
        ownerId,
      });
    }
  }

  public async getGroupJobs(
    groupId: string,
    status: "completed" | "failed",
    limit?: number,
    offset = 0,
    _logger: Logger = logger,
  ): Promise<Array<NuQJob<JobData, JobReturnValue>>> {
    const start = Date.now();
    try {
      return (
        await nuqPool.query<JobRow<JobData, JobReturnValue>>(
          `
            SELECT ${this.jobReturning.join(", ")}
            FROM ${this.queueName}
            WHERE ${this.queueName}.group_id = $1
            AND ${this.queueName}.status = $2::nuq.job_status
            AND ${this.queueName}.data->>'mode' = 'single_urls'
            ORDER BY ${status === "completed" ? "finished_at ASC, created_at ASC, id ASC" : "id ASC"}
            LIMIT $3 OFFSET $4;
          `,
          [groupId, status, limit ?? null, offset],
        )
      ).rows.map(row => this.rowToJob(row));
    } finally {
      _logger.info("nuqGetGroupJobs metrics", {
        module: "nuq/metrics",
        method: "nuqGetGroupJobs",
        duration: Date.now() - start,
        crawlId: groupId,
        status,
      });
    }
  }

  public async removeJob(
    id: string,
    _logger: Logger = logger,
  ): Promise<boolean> {
    const start = Date.now();
    try {
      return (
        (
          await nuqPool.query(`DELETE FROM ${this.queueName} WHERE id = $1;`, [
            id,
          ])
        ).rowCount !== 0
      );
    } finally {
      _logger.info("nuqRemoveJob metrics", {
        module: "nuq/metrics",
        method: "nuqRemoveJob",
        duration: Date.now() - start,
        scrapeId: id,
      });
    }
  }

  public async removeJobs(
    ids: Array<string>,
    _logger: Logger = logger,
  ): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const start = Date.now();
    try {
      return (
        (
          await nuqPool.query(
            `DELETE FROM ${this.queueName} WHERE id = ANY($1::uuid[]);`,
            [ids],
          )
        ).rowCount ?? 0
      );
    } finally {
      _logger.info("nuqRemoveJobs metrics", {
        module: "nuq/metrics",
        method: "nuqRemoveJobs",
        duration: Date.now() - start,
        scrapeIds: ids.length,
      });
    }
  }

  // === Producer
  public async addJob(
    id: string,
    data: JobData,
    options: NuQJobOptions,
  ): Promise<NuQJob<JobData, JobReturnValue>> {
    return withSpan(
      "nuq.addJob",
      async span => {
        setSpanAttributes(span, {
          "nuq.queue_name": this.queueName,
          "nuq.job_id": id,
          "nuq.priority": options.priority ?? 0,
          "nuq.zero_data_retention": storedZeroDataRetention(data) ?? false,
          "nuq.listenable": options.listenable ?? false,
        });

        const start = Date.now();
        try {
          const row = (
            await nuqPool.query<JobRow<JobData, JobReturnValue>>(
              `INSERT INTO ${this.queueName}${options.backlogged ? "_backlog" : ""} (id, data, priority, listen_channel_id, owner_id, group_id${options.backlogged ? ", times_out_at" : ""}) VALUES ($1, $2, $3, $4, $5, $6${options.backlogged ? ", $7" : ""}) RETURNING ${(options.backlogged ? this.jobBacklogReturning : this.jobReturning).join(", ")};`,
              [
                id,
                data,
                options.priority ?? 0,
                options.listenable ? this.listenChannelId : null,
                normalizeOwnerId(options.ownerId),
                options.groupId ?? null,
                ...(options.backlogged
                  ? [
                      options.backloggedTimesOutAt
                        ? options.backloggedTimesOutAt.toISOString()
                        : null,
                    ]
                  : []),
              ],
            )
          ).rows[0];
          if (!row) {
            throw new Error("Failed to insert NuQ job");
          }
          const result = this.rowToJob(row, options.backlogged);

          setSpanAttributes(span, {
            "nuq.job_created": true,
          });

          return result;
        } finally {
          const duration = Date.now() - start;
          setSpanAttributes(span, {
            "nuq.duration_ms": duration,
          });
          logger.info("nuqAddJob metrics", {
            module: "nuq/metrics",
            method: "nuqAddJob",
            duration,
            scrapeId: id,
            zeroDataRetention: storedZeroDataRetention(data) ?? false,
          });
        }
      },
      { zeroDataRetention: storedZeroDataRetention(data) === true },
    );
  }

  public async addJobIfNotExists(
    id: string,
    data: JobData,
    options: NuQJobOptions,
  ): Promise<NuQJob<JobData, JobReturnValue> | null> {
    return withSpan(
      "nuq.addJob",
      async span => {
        setSpanAttributes(span, {
          "nuq.queue_name": this.queueName,
          "nuq.job_id": id,
          "nuq.priority": options.priority ?? 0,
          "nuq.zero_data_retention": storedZeroDataRetention(data) ?? false,
          "nuq.listenable": options.listenable ?? false,
        });

        const start = Date.now();
        try {
          const result = this.maybeRowToJob(
            (
              await nuqPool.query<JobRow<JobData, JobReturnValue>>(
                `INSERT INTO ${this.queueName}${options.backlogged ? "_backlog" : ""} (id, data, priority, listen_channel_id, owner_id, group_id${options.backlogged ? ", times_out_at" : ""}) VALUES ($1, $2, $3, $4, $5, $6${options.backlogged ? ", $7" : ""}) ON CONFLICT (id) DO NOTHING RETURNING ${(options.backlogged ? this.jobBacklogReturning : this.jobReturning).join(", ")};`,
                [
                  id,
                  data,
                  options.priority ?? 0,
                  options.listenable ? this.listenChannelId : null,
                  normalizeOwnerId(options.ownerId),
                  options.groupId ?? null,
                  ...(options.backlogged
                    ? [
                        options.backloggedTimesOutAt
                          ? options.backloggedTimesOutAt.toISOString()
                          : null,
                      ]
                    : []),
                ],
              )
            ).rows[0],
            options.backlogged,
          );

          setSpanAttributes(span, {
            "nuq.job_created": result !== null,
          });

          return result;
        } finally {
          const duration = Date.now() - start;
          setSpanAttributes(span, {
            "nuq.duration_ms": duration,
          });
          logger.info("nuqAddJob metrics", {
            module: "nuq/metrics",
            method: "nuqAddJob",
            duration,
            scrapeId: id,
            zeroDataRetention: storedZeroDataRetention(data) ?? false,
          });
        }
      },
      { zeroDataRetention: storedZeroDataRetention(data) === true },
    );
  }

  public async addJobs(
    jobs: Array<{
      id: string;
      data: JobData;
      options: NuQJobOptions;
    }>,
  ): Promise<Array<NuQJob<JobData, JobReturnValue>>> {
    return withSpan(
      "nuq.addJobs",
      async span => {
        setSpanAttributes(span, {
          "nuq.queue_name": this.queueName,
          "nuq.jobs_count": jobs.length,
        });

        if (jobs.length === 0) {
          return [];
        }

        const start = Date.now();
        try {
          // Separate jobs into backlogged and non-backlogged groups
          const regularJobs: typeof jobs = [];
          const backloggedJobs: typeof jobs = [];

          for (const job of jobs) {
            if (job.options.backlogged) {
              backloggedJobs.push(job);
            } else {
              regularJobs.push(job);
            }
          }

          const results: Array<NuQJob<JobData, JobReturnValue>> = [];

          // Batch size: 6 params per job, stay well under PG's 65535 param limit
          // 1000 jobs = 6000 params, leaving plenty of headroom
          const BATCH_SIZE = 1000;

          // Helper function to build and execute bulk insert with batching
          const bulkInsert = async (
            jobsToInsert: typeof jobs,
            tableSuffix: string,
          ) => {
            if (jobsToInsert.length === 0) {
              return;
            }

            // Process in batches
            for (
              let offset = 0;
              offset < jobsToInsert.length;
              offset += BATCH_SIZE
            ) {
              const batch = jobsToInsert.slice(offset, offset + BATCH_SIZE);

              // Build the VALUES clause and parameters array
              const valuesPlaceholders: Array<string> = [];
              const params: Array<unknown> = [];

              const columns = [
                "id",
                "data",
                "priority",
                "listen_channel_id",
                "owner_id",
                "group_id",
                ...(tableSuffix === "_backlog" ? ["times_out_at"] : []),
              ];

              for (let i = 0; i < batch.length; i++) {
                const job = batch[i];
                const baseIdx = i * columns.length + 1;

                valuesPlaceholders.push(
                  `(${new Array(columns.length)
                    .fill(0)
                    .map((_, i) => "$" + (baseIdx + i))
                    .join(", ")})`,
                );

                params.push(
                  job.id,
                  job.data,
                  job.options.priority ?? 0,
                  job.options.listenable ? this.listenChannelId : null,
                  normalizeOwnerId(job.options.ownerId),
                  job.options.groupId ?? null,
                  ...(tableSuffix === "_backlog"
                    ? [
                        job.options.backloggedTimesOutAt
                          ? job.options.backloggedTimesOutAt.toISOString()
                          : null,
                      ]
                    : []),
                );
              }

              const query = `INSERT INTO ${this.queueName}${tableSuffix} (${columns.join(", ")}) VALUES ${valuesPlaceholders.join(", ")} RETURNING ${(tableSuffix === "_backlog" ? this.jobBacklogReturning : this.jobReturning).join(", ")};`;

              const result = await nuqPool.query<
                JobRow<JobData, JobReturnValue>
              >(query, params);

              // Convert rows to jobs and maintain order
              const jobMap = new Map(
                result.rows.map(row => [
                  row.id,
                  this.rowToJob(row, tableSuffix === "_backlog"),
                ]),
              );

              for (const job of batch) {
                const insertedJob = jobMap.get(job.id);
                if (insertedJob) {
                  results.push(insertedJob);
                }
              }
            }
          };

          // Insert regular jobs
          await bulkInsert(regularJobs, "");

          // Insert backlogged jobs
          await bulkInsert(backloggedJobs, "_backlog");

          setSpanAttributes(span, {
            "nuq.jobs_created": results.length,
            "nuq.regular_jobs_count": regularJobs.length,
            "nuq.backlogged_jobs_count": backloggedJobs.length,
          });

          return results;
        } finally {
          const duration = Date.now() - start;
          setSpanAttributes(span, {
            "nuq.duration_ms": duration,
          });
          logger.info("nuqAddJobs metrics", {
            module: "nuq/metrics",
            method: "nuqAddJobs",
            duration,
            jobsCount: jobs.length,
          });
        }
      },
      {
        zeroDataRetention: jobs.some(
          job => storedZeroDataRetention(job.data) === true,
        ),
      },
    );
  }

  public async promoteJobFromBacklogOrAdd(
    id: string,
    data: JobData,
    options: NuQJobOptions,
  ): Promise<NuQJob<JobData, JobReturnValue> | null> {
    return withSpan(
      "nuq.promoteJobFromBacklogOrAdd",
      async span => {
        setSpanAttributes(span, {
          "nuq.queue_name": this.queueName,
          "nuq.job_id": id,
          "nuq.priority": options.priority ?? 0,
          "nuq.zero_data_retention": storedZeroDataRetention(data) ?? false,
          "nuq.listenable": options.listenable ?? false,
        });

        const start = Date.now();
        try {
          const result = this.maybeRowToJob(
            (
              await nuqPool.query<JobRow<JobData, JobReturnValue>>(
                `
                WITH ins AS (
                  INSERT INTO ${this.queueName} (id, data, created_at, priority, listen_channel_id, owner_id, group_id)
                  SELECT b.id, b.data, b.created_at, b.priority, b.listen_channel_id, b.owner_id, b.group_id
                  FROM ${this.queueName}_backlog b
                  WHERE b.id = $1
                  LIMIT 1
                  ON CONFLICT (id) DO NOTHING
                  RETURNING ${this.jobReturning.join(", ")}
                ), del AS (
                  DELETE FROM ${this.queueName}_backlog
                  WHERE id = $1
                )
                SELECT * FROM ins
              `,
                [id],
              )
            ).rows[0],
          );

          if (!result) {
            return await this.addJobIfNotExists(id, data, {
              ...options,
              backlogged: false,
            });
          }

          return result;
        } finally {
          const duration = Date.now() - start;
          setSpanAttributes(span, {
            "nuq.duration_ms": duration,
          });
          logger.info("nuqPromoteJobFromBacklogOrAdd metrics", {
            module: "nuq/metrics",
            method: "nuqPromoteJobFromBacklogOrAdd",
            duration,
          });
        }
      },
      { zeroDataRetention: storedZeroDataRetention(data) === true },
    );
  }

  private readonly nuqWaitMode =
    config.NUQ_WAIT_MODE === "listen" || config.NUQ_RABBITMQ_URL
      ? ("listen" as const)
      : ("poll" as const);

  public waitForJob(
    id: string,
    timeout: number | null,
    _logger: Logger = logger,
  ): Promise<JobReturnValue | null> {
    return withSpan("nuq.waitForJob", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
        "nuq.timeout": timeout ?? undefined,
        "nuq.wait_mode": this.nuqWaitMode,
      });

      const startTime = Date.now();

      const done = new Promise<JobReturnValue | null>((resolve, reject) => {
        if (this.nuqWaitMode === "listen") {
          let timer: NodeJS.Timeout | null = null;

          const listener = (_msg: "completed" | "failed") => {
            if (timer) {
              clearTimeout(timer);
            }
            void (async () => {
              try {
                const job = await this.getJob(id, _logger);
                if (!job) {
                  reject(new Error("Job raced out while waiting for it"));
                } else if (job.status === "completed") {
                  resolve(job.returnvalue ?? null);
                } else {
                  reject(new Error(job.failedReason));
                }
              } catch (error: unknown) {
                reject(error);
              }
            })();
          };

          if (timeout !== null) {
            timer = setTimeout(() => {
              this.removeListener(id, listener);
              reject(new Error("Timed out"));
            }, timeout);
          }

          void (async () => {
            try {
              await this.addListener(id, listener);
            } catch (error: unknown) {
              if (timer) {
                clearTimeout(timer);
              }
              reject(error);
              return;
            }

            try {
              const job = await this.getJob(id, _logger);
              if (
                job &&
                (job.status === "completed" || job.status === "failed")
              ) {
                this.removeListener(id, listener);
                if (timer) {
                  clearTimeout(timer);
                }
                if (job.status === "completed") {
                  resolve(job.returnvalue ?? null);
                } else {
                  reject(new Error(job.failedReason));
                }
              }
            } catch (error: unknown) {
              _logger.warn("nuqGetJob ensure check failed", {
                module: "nuq",
                method: "nuqWaitForJob",
                error,
                scrapeId: id,
              });
            }
          })();
        } else {
          const timeoutAt = timeout !== null ? Date.now() + timeout : null;
          const poll = async (): Promise<void> => {
            try {
              const job = await this.getJob(id, _logger);
              if (
                job &&
                (job.status === "completed" || job.status === "failed")
              ) {
                if (job.status === "completed") {
                  resolve(job.returnvalue ?? null);
                } else {
                  reject(new Error(job.failedReason));
                }
                return;
              }
            } catch (error: unknown) {
              reject(error);
              return;
            }

            if (timeoutAt && Date.now() > timeoutAt) {
              reject(new Error("Timed out"));
              return;
            }

            setTimeout(() => {
              void poll();
            }, 500);
          };

          void poll();
        }
      });

      const result = await done;

      setSpanAttributes(span, {
        "nuq.wait_duration_ms": Date.now() - startTime,
        "nuq.wait_success": true,
      });

      return result;
    });
  }

  // === Prefetch

  public async prefetchJobs(_logger: Logger = logger): Promise<number> {
    const start = Date.now();
    try {
      const jobs = (
        await nuqPool.query<JobRow<JobData, JobReturnValue>>(
          `
            WITH next AS (SELECT id FROM ${this.queueName} WHERE ${this.queueName}.status = 'queued'::nuq.job_status ORDER BY ${this.queueName}.priority ASC, ${this.queueName}.created_at ASC FOR UPDATE SKIP LOCKED LIMIT 500)
            UPDATE ${this.queueName} q SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now() FROM next WHERE q.id = next.id RETURNING ${this.jobReturning.map(x => `q.${x}`).join(", ")};
          `,
        )
      ).rows.map(row => this.rowToJob(row));

      for (const job of jobs) {
        await this.sendJobPrefetch(
          job,
          _logger.child({
            jobId: job.id,
            zeroDataRetention: !!storedZeroDataRetention(job.data),
          }),
        );
      }

      _logger.info("Prefetched jobs", {
        module: "nuq/metrics",
        jobCount: jobs.length,
      });

      return jobs.length;
    } finally {
      _logger.info("nuqPrefetchJobs metrics", {
        module: "nuq/metrics",
        method: "nuqPrefetchJobs",
        duration: Date.now() - start,
      });
    }
  }

  // === Consumer

  public async getJobToProcess(): Promise<NuQJob<
    JobData,
    JobReturnValue
  > | null> {
    const start = Date.now();
    try {
      if (config.NUQ_RABBITMQ_URL) {
        await this.startSender();

        if (this.sender) {
          let message: amqp.GetMessage | false = false;
          let transportOk = false;
          try {
            message = await this.sender.channel.get(
              this.queueName + ".prefetch",
              { noAck: true },
            );
            transportOk = true;
          } catch (error: unknown) {
            logger.warn("NuQ sender get failed, falling back to postgres", {
              module: "nuq/rabbitmq",
              err: error,
            });
            // Reset sender so it can be re-established on next call
            this.sender = null;
          }
          if (transportOk) {
            if (message === false) {
              return null;
            }
            let parsedEnvelope: { id: string; lock?: string } | undefined;
            try {
              const parsed: unknown = JSON.parse(message.content.toString());
              const env = rabbitJobEnvelopeSchema.safeParse(parsed);
              if (env.success) {
                parsedEnvelope = {
                  id: env.data.id,
                  lock: optionalString(env.data.lock),
                };
              }
              return this.rabbitRowToJob(parsed);
            } catch (error: unknown) {
              logger.error("Failed to decode NuQ RabbitMQ job payload", {
                module: "nuq/rabbitmq",
                queueName: this.queueName,
                jobId: parsedEnvelope?.id,
                err: error,
              });
              if (parsedEnvelope?.lock) {
                const failedReason =
                  error instanceof Error
                    ? error.message
                    : "Invalid job data payload";
                await this.jobFail(
                  parsedEnvelope.id,
                  parsedEnvelope.lock,
                  failedReason,
                  logger,
                ).catch((failError: unknown) => {
                  logger.error(
                    "Failed to mark corrupt NuQ RabbitMQ job failed",
                    {
                      module: "nuq/rabbitmq",
                      queueName: this.queueName,
                      jobId: parsedEnvelope?.id,
                      err: failError,
                    },
                  );
                });
              }
              return null;
            }
          }
        } else {
          logger.warn("NuQ sender not started, falling back to postgres", {
            module: "nuq/rabbitmq",
          });
        }
      }

      return this.maybeRowToJob(
        (
          await nuqPool.query<JobRow<JobData, JobReturnValue>>(
            `
              WITH next AS (SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.status = 'queued'::nuq.job_status ORDER BY ${this.queueName}.priority ASC, ${this.queueName}.created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1)
              UPDATE ${this.queueName} q SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now() FROM next WHERE q.id = next.id RETURNING ${this.jobReturning.map(x => `q.${x}`).join(", ")};
            `,
          )
        ).rows[0],
      );
    } finally {
      logger.info("nuqGetJobToProcess metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobToProcess",
        duration: Date.now() - start,
      });
    }
  }

  public async reclaimLock(
    id: string,
    _logger: Logger = logger,
  ): Promise<string | null> {
    const start = Date.now();
    try {
      const row = (
        await nuqPool.query<LockRow>(
          `UPDATE ${this.queueName} SET lock = COALESCE(lock, gen_random_uuid()), locked_at = now() WHERE id = $1 AND status = 'active'::nuq.job_status RETURNING lock;`,
          [id],
        )
      ).rows[0];
      return row?.lock ?? null;
    } finally {
      _logger.info("nuqReclaimLock metrics", {
        module: "nuq/metrics",
        method: "nuqReclaimLock",
        duration: Date.now() - start,
        scrapeId: id,
      });
    }
  }

  public async renewLock(
    id: string,
    lock: string,
    _logger: Logger = logger,
  ): Promise<boolean> {
    const start = Date.now();
    try {
      return (
        (
          await nuqPool.query(
            `UPDATE ${this.queueName} SET locked_at = now() WHERE id = $1 AND lock = $2 AND status = 'active'::nuq.job_status;`,
            [id, lock],
          )
        ).rowCount !== 0
      );
    } finally {
      _logger.info("nuqRenewLock metrics", {
        module: "nuq/metrics",
        method: "nuqRenewLock",
        duration: Date.now() - start,
        scrapeId: id,
      });
    }
  }

  public async jobFinish(
    id: string,
    lock: string,
    returnvalue: unknown,
    _logger: Logger = logger,
  ): Promise<boolean> {
    return withSpan("nuq.jobFinish", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
      });

      const start = Date.now();
      try {
        const result = await nuqPool.query<JobSignalRow>(
          `UPDATE ${this.queueName} SET status = 'completed'::nuq.job_status, lock = null, locked_at = null, finished_at = now(), returnvalue = $3 WHERE id = $1 AND lock = $2 RETURNING id, listen_channel_id;`,
          [id, lock, returnvalue],
        );

        const success = result.rowCount !== 0;

        if (success && result.rows[0]) {
          const job = result.rows[0];
          if (this.nuqWaitMode === "listen" && !config.NUQ_RABBITMQ_URL) {
            await nuqPool.query(`SELECT pg_notify('${this.queueName}', $1);`, [
              job.id + "|completed",
            ]);
          } else if (config.NUQ_RABBITMQ_URL && job.listen_channel_id) {
            await this.sendJobEnd(
              job.id,
              "completed",
              job.listen_channel_id,
              _logger,
            );
          }
        }

        setSpanAttributes(span, {
          "nuq.job_finished": success,
        });

        return success;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        _logger.info("nuqJobFinish metrics", {
          module: "nuq/metrics",
          method: "nuqJobFinish",
          duration,
          scrapeId: id,
        });
      }
    });
  }

  public async jobFail(
    id: string,
    lock: string,
    failedReason: string,
    _logger: Logger = logger,
  ): Promise<boolean> {
    return withSpan("nuq.jobFail", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
        "nuq.failed_reason": failedReason,
      });

      const start = Date.now();
      try {
        const result = await nuqPool.query<JobSignalRow>(
          `UPDATE ${this.queueName} SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, finished_at = now(), failedreason = $3 WHERE id = $1 AND lock = $2 RETURNING id, listen_channel_id;`,
          [id, lock, failedReason],
        );

        const success = result.rowCount !== 0;

        if (success && result.rows[0]) {
          const job = result.rows[0];
          if (this.nuqWaitMode === "listen" && !config.NUQ_RABBITMQ_URL) {
            await nuqPool.query(`SELECT pg_notify('${this.queueName}', $1);`, [
              job.id + "|failed",
            ]);
          } else if (config.NUQ_RABBITMQ_URL && job.listen_channel_id) {
            await this.sendJobEnd(
              job.id,
              "failed",
              job.listen_channel_id,
              _logger,
            );
          }
        }

        setSpanAttributes(span, {
          "nuq.job_failed": success,
        });

        return success;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        _logger.info("nuqJobFail metrics", {
          module: "nuq/metrics",
          method: "nuqJobFail",
          duration,
          scrapeId: id,
        });
      }
    });
  }

  // === Metrics
  public async getMetrics(): Promise<string> {
    const start = Date.now();
    // swapped to slim version for performance reasons - mogery
    // const result = await nuqPool.query(`
    //   SELECT status::text, COUNT(id) as count FROM ${this.queueName} GROUP BY status
    //   ${this.options.backlog ? `UNION ALL SELECT 'backlog'::text as status, COUNT(id) as count FROM ${this.queueName}_backlog` : ""}
    // `);
    const result = await nuqPool.query<StatusCountRow>(`
      SELECT status::text, COUNT(id) as count FROM ${this.queueName} WHERE status IN ('queued', 'active') GROUP BY status
    `);
    logger.info("nuqGetMetrics metrics", {
      module: "nuq/metrics",
      method: "nuqGetMetrics",
      duration: Date.now() - start,
    });
    const prometheusQueueName = this.queueName.replace(".", "_");

    const statusCounts = new Map<NuQJobStatus, number>([
      ["queued", 0],
      ["active", 0],
      ["completed", 0],
      ["failed", 0],
      ["backlog", 0],
    ]);

    result.rows.forEach(x => {
      const parsedStatus = safeParseLogged(
        nuqJobStatusSchema,
        x.status,
        "nuq.pg.metricsStatus",
      );
      if (parsedStatus.success) {
        statusCounts.set(parsedStatus.data, Number.parseInt(x.count, 10));
      }
    });

    return `# HELP ${prometheusQueueName}_job_count Number of jobs in each status\n# TYPE ${prometheusQueueName}_job_count gauge\n${Array.from(
      statusCounts.entries(),
    )
      .map(
        ([status, count]) =>
          `${prometheusQueueName}_job_count{status="${status}"} ${count}`,
      )
      .join("\n")}\n`;
  }

  // === Cleanup
  public async shutdown() {
    this.shuttingDown = true;
    if (this.listener) {
      const nl = this.listener;
      this.listener = null;
      this.listens = {};
      if (nl.type === "postgres") {
        await nl.client.query(`UNLISTEN "${this.queueName}";`);
        await nl.client.end();
      } else {
        await closeAmqpResource(
          () => nl.channel.cancel(nl.queue),
          "listener channel consumer",
        );
        await closeAmqpResource(() => nl.channel.close(), "listener channel");
        await closeAmqpResource(
          () => nl.connection.close(),
          "listener connection",
        );
      }
    }
    if (this.sender) {
      const ns = this.sender;
      this.sender = null;
      await closeAmqpResource(() => ns.channel.close(), "sender channel");
      await closeAmqpResource(() => ns.connection.close(), "sender connection");
    }
  }
}

// === Group Management

export type NuQGroupStatus = "active" | "completed" | "cancelled";

export type NuQJobGroupInstance = {
  id: string;
  status: NuQGroupStatus;
  createdAt: Date;
  ownerId: string;
  ttl: number;
  expiresAt?: Date;
};

class NuQJobGroup {
  constructor(public readonly groupName: string) {}

  private readonly groupReturning = [
    "id",
    "status",
    "created_at",
    "owner_id",
    "ttl",
    "expires_at",
  ];

  private rowToGroup(row: GroupRow): NuQJobGroupInstance {
    return {
      id: row.id,
      status: row.status,
      createdAt: new Date(row.created_at),
      ownerId: row.owner_id,
      ttl: row.ttl,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    };
  }

  private maybeRowToGroup(
    row: GroupRow | undefined,
  ): NuQJobGroupInstance | null {
    return row ? this.rowToGroup(row) : null;
  }

  public async addGroup(
    id: string,
    ownerId: string,
    ttl?: number,
    _logger: Logger = logger,
  ): Promise<NuQJobGroupInstance> {
    return withSpan("nuq.addGroup", async span => {
      setSpanAttributes(span, {
        "nuq.group_name": this.groupName,
        "nuq.group_id": id,
        "nuq.ttl": ttl ?? 86_400_000,
      });

      const start = Date.now();
      try {
        const row = (
          await nuqPool.query<GroupRow>(
            `INSERT INTO ${this.groupName} (id, owner_id, ttl) VALUES ($1, $2, $3) RETURNING ${this.groupReturning.join(", ")};`,
            [id, normalizeOwnerId(ownerId), ttl ?? 86_400_000],
          )
        ).rows[0];
        if (!row) {
          throw new Error("Failed to insert NuQ group");
        }
        const result = this.rowToGroup(row);

        setSpanAttributes(span, {
          "nuq.group_created": true,
        });

        return result;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        _logger.info("nuqAddGroup metrics", {
          module: "nuq/metrics",
          method: "nuqAddGroup",
          duration,
          groupId: id,
        });
      }
    });
  }

  public async getGroup(
    id: string,
    _logger: Logger = logger,
  ): Promise<NuQJobGroupInstance | null> {
    return withSpan("nuq.getGroup", async span => {
      setSpanAttributes(span, {
        "nuq.group_name": this.groupName,
        "nuq.group_id": id,
      });

      const start = Date.now();
      try {
        const result = this.maybeRowToGroup(
          (
            await nuqPool.query<GroupRow>(
              `SELECT ${this.groupReturning.join(", ")} FROM ${this.groupName} WHERE ${this.groupName}.id = $1;`,
              [id],
            )
          ).rows[0],
        );

        setSpanAttributes(span, {
          "nuq.group_found": result !== null,
          "nuq.group_status": result?.status,
        });

        return result;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        _logger.info("nuqGetGroup metrics", {
          module: "nuq/metrics",
          method: "nuqGetGroup",
          duration,
          groupId: id,
        });
      }
    });
  }

  public async getOngoingByOwner(
    ownerId: string,
    _logger: Logger = logger,
  ): Promise<Array<NuQJobGroupInstance>> {
    return withSpan("nuq.getGroupByOwner", async span => {
      setSpanAttributes(span, {
        "nuq.group_name": this.groupName,
        "nuq.owner_id": ownerId,
      });

      const start = Date.now();
      try {
        const result = (
          await nuqPool.query<GroupRow>(
            `SELECT ${this.groupReturning.join(", ")} FROM ${this.groupName} WHERE ${this.groupName}.owner_id = $1 AND ${this.groupName}.status = 'active'`,
            [normalizeOwnerId(ownerId)],
          )
        ).rows.map(x => this.rowToGroup(x));

        setSpanAttributes(span, {
          "nuq.groups_found": result.length,
        });

        return result;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        _logger.info("nuqGetGroup metrics", {
          module: "nuq/metrics",
          method: "nuqGetGroupByOwner",
          duration,
          ownerId,
        });
      }
    });
  }
}

export function nuqGetLocalMetrics(): string {
  return `# HELP nuq_pool_waiting_count Number of requests waiting in the pool\n# TYPE nuq_pool_waiting_count gauge\nnuq_pool_waiting_count ${nuqPool.waitingCount}\n
# HELP nuq_pool_idle_count Number of connections idle in the pool\n# TYPE nuq_pool_idle_count gauge\nnuq_pool_idle_count ${nuqPool.idleCount}\n
# HELP nuq_pool_total_count Number of connections in the pool\n# TYPE nuq_pool_total_count gauge\nnuq_pool_total_count ${nuqPool.totalCount}\n`;
}

export async function nuqHealthCheck(): Promise<boolean> {
  const start = Date.now();
  try {
    return (await nuqPool.query("SELECT 1;")).rowCount !== 0;
  } finally {
    logger.info("nuqHealthCheck metrics", {
      module: "nuq/metrics",
      method: "nuqHealthCheck",
      duration: Date.now() - start,
    });
  }
}

// === Instances

export const scrapeQueue = new NuQ<ScrapeJobData, Document | null>(
  "nuq.queue_scrape",
  {
    backlog: true,
    decodeData: decodeScrapeJobData,
    decodeReturnvalue: decodeScrapeReturnValue,
  },
);
export const crawlFinishedQueue = new NuQ<JsonValue, JsonValue>(
  "nuq.queue_crawl_finished",
  {
    decodeData: decodeJsonValue,
    decodeReturnvalue: decodeJsonValue,
  },
);

export const crawlGroup = new NuQJobGroup("nuq.group_crawl");

// === Cleanup

export async function nuqShutdown() {
  await Promise.all([
    scrapeQueue.shutdown(),
    crawlFinishedQueue.shutdown(),
    nuqRedis.shutdown(),
  ]);
  await nuqPool.end();
}
