import { Logger } from "winston";
import { logger } from "../../lib/logger";
import { Client, Pool, type PoolClient } from "pg";
import { type ScrapeJobData } from "../../types";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import amqp from "amqplib";
import { normalizeOwnerId } from "../../lib/owner-id";
import { config } from "../../config";
import { nuqRedis } from "./redis";
import {
  retireNuQPgObject,
  validateNuQPgPublicationUnderLock,
} from "./nuq-pg-publication";

// === Basics

const nuqPool = new Pool({
  connectionString: config.NUQ_DATABASE_URL, // may be a pgbouncer transaction pooler URL
  application_name: "nuq",
});

nuqPool.on("error", err =>
  logger.error("Error in NuQ idle client", { err, module: "nuq" }),
);

export type NuQJobStatus =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "backlog";
export type NuQJob<Data = any, ReturnValue = any> = {
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
  backloggedTimesOutAt?: Date;
};

type NuQJobOptions = {
  priority?: number;
  listenable?: boolean;
  ownerId?: string;
  groupId?: string;
  backlogged?: boolean;
  backloggedTimesOutAt?: Date;
};

export class NuQPublicationConflictError extends Error {
  constructor(
    public readonly jobId: string,
    reason: string,
  ) {
    super(`NuQ publication conflict for ${jobId}: ${reason}`);
    this.name = "NuQPublicationConflictError";
  }
}

export class NuQGroupPublicationConflictError extends Error {
  constructor(
    public readonly groupId: string,
    reason: string,
  ) {
    super(`NuQ group publication conflict for ${groupId}: ${reason}`);
    this.name = "NuQGroupPublicationConflictError";
  }
}

export type NuQRemovedJobResidue = {
  id: string;
  ownerId?: string;
  groupId?: string;
  data: unknown;
};

export type NuQPgOwnerLiveResidue = {
  scrape: number;
  backlog: number;
  groups: number;
  crawlFinished: number;
  total: number;
};

function publicationComparableData(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...(value as Record<string, unknown>) };
  delete result.traceContext;
  delete result.concurrencyLimited;
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function canonicalJson(value: unknown): string {
  // Match node-postgres JSONB parameter semantics first (toJSON, omitted
  // undefined object fields, null array holes), then canonicalize key order.
  return stableJson(JSON.parse(JSON.stringify(value) ?? "null"));
}

function canonicalUuid(value: string): string {
  return value.toLowerCase();
}

type NuQOptions = {
  backlog?: boolean;
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

async function closeAmqpResource(
  close: () => Promise<unknown>,
  resource: string,
) {
  try {
    await close();
  } catch (error) {
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

class NuQ<JobData = any, JobReturnValue = any> {
  private listenChannelId: string =
    config.NUQ_POD_NAME + "-" + crypto.randomUUID();

  constructor(
    public readonly queueName: string,
    public readonly options: NuQOptions,
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
    [key: string]: ((status: "completed" | "failed") => void)[];
  } = {};
  private listenerStarting = false;
  private shuttingDown = false;

  private async startListener() {
    if (this.listener || this.shuttingDown || this.listenerStarting) return;

    if (config.NUQ_RABBITMQ_URL) {
      this.listenerStarting = true;

      try {
        const connection = await amqp.connect(config.NUQ_RABBITMQ_URL);
        const channel = await connection.createChannel();
        await channel.prefetch(5);
        const queue = await channel.assertQueue(
          this.queueName + ".listen." + this.listenChannelId,
          {
            exclusive: true,
            autoDelete: true,
            durable: false,
            arguments: {
              "x-queue-type": "classic",
              "x-message-ttl": 60000,
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

      const onClose = function onClose() {
        logger.info("NuQ listener channel closed", {
          module: "nuq/rabbitmq",
        });
        this.listener = null;

        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(
          (() => {
            this.startListener().catch(err =>
              logger.error("Error in NuQ listener reconnect", {
                err,
                module: "nuq/rabbitmq",
              }),
            );
          }).bind(this),
          250,
        );
        return;
      }.bind(this);

      this.listener.connection.on("close", onClose);
      this.listener.channel.on("close", onClose);

      await this.listener.channel.consume(
        this.listener.queue,
        (msg => {
          if (msg === null) {
            onClose();
            return;
          }

          logger.info("NuQ job received", {
            module: "nuq/rabbitmq",
            jobId: msg.properties.correlationId,
            status: msg.content.toString(),
          });

          const jobId = msg.properties.correlationId as string;
          const status = msg.content.toString() as "completed" | "failed";

          if (jobId in this.listens) {
            this.listens[jobId].forEach(listener => listener(status));
          }
          delete this.listens[jobId];

          if (this.listener && this.listener.type === "rabbitmq") {
            this.listener.channel.ack(msg);
          }
        }).bind(this),
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
          if (tok[0] in this.listens) {
            this.listens[tok[0]].forEach(listener =>
              listener(tok[1] as "completed" | "failed"),
            );
            delete this.listens[tok[0]];
          }
        });

        this.listener.client.on("error", err => {
          logger.error("Error in NuQ listener", { err, module: "nuq" });
          // Trigger cleanup and reconnection on error
          if (this.listener && this.listener.type === "postgres") {
            const nl = this.listener;
            this.listener = null;
            nl.client.end().catch(() => {});
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(
              (() => {
                this.startListener().catch(err =>
                  logger.error("Error in NuQ listener reconnect", {
                    err,
                    module: "nuq",
                  }),
                );
              }).bind(this),
              250,
            );
          }
        });

        this.listener.client.on("end", () => {
          logger.info("NuQ listener disconnected", { module: "nuq" });
          this.listener = null;

          if (reconnectTimeout) clearTimeout(reconnectTimeout);
          reconnectTimeout = setTimeout(
            (() => {
              this.startListener().catch(err =>
                logger.error("Error in NuQ listener reconnect", {
                  err,
                  module: "nuq",
                }),
              );
            }).bind(this),
            250,
          );
        });

        await this.listener.client.connect();
        await this.listener.client.query(`LISTEN "${this.queueName}";`);
      } finally {
        this.listenerStarting = false;
      }
    }

    (async () => {
      const backedUpJobs = (
        await this.getJobs(Object.keys(this.listens))
      ).filter(job => ["completed", "failed"].includes(job.status));
      for (const job of backedUpJobs) {
        this.listens[job.id].forEach(listener =>
          listener(job.status as "completed" | "failed"),
        );
        delete this.listens[job.id];
      }
    })();
  }

  private async addListener(
    id: string,
    listener: (status: "completed" | "failed") => void,
  ) {
    await this.startListener();

    if (!(id in this.listens)) this.listens[id] = [listener];
    else this.listens[id].push(listener);
  }

  private async removeListener(
    id: string,
    listener: (status: "completed" | "failed") => void,
  ) {
    if (id in this.listens) {
      this.listens[id] = this.listens[id].filter(l => l !== listener);
      if (this.listens[id].length === 0) delete this.listens[id];
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
    if (this.sender || this.shuttingDown || this.senderStarting) return;
    this.senderStarting = true;

    try {
      if (config.NUQ_RABBITMQ_URL) {
        const connection = await amqp.connect(config.NUQ_RABBITMQ_URL);
        const channel = await connection.createChannel();
        await channel.assertQueue(this.queueName + ".prefetch", {
          durable: true,
          arguments: {
            "x-queue-type": "quorum",
            "x-max-length": 20000,
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

        channel.on("error", err => {
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

        connection.on("error", err => {
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
    "times_out_at",
  ];

  private rowToJob(
    row: any,
    backlogged?: boolean,
  ): NuQJob<JobData, JobReturnValue> | null {
    if (!row) return null;
    return {
      id: row.id,
      status: backlogged ? "backlog" : row.status,
      createdAt: new Date(row.created_at),
      priority: row.priority,
      data: row.data,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
      listenChannelId: row.listen_channel_id ?? undefined,
      returnvalue: row.returnvalue ?? undefined,
      failedReason: row.failedreason ?? undefined,
      lock: row.lock ?? undefined,
      ownerId: row.owner_id ?? undefined,
      groupId: row.group_id ?? undefined,
      backloggedTimesOutAt: row.times_out_at
        ? new Date(row.times_out_at)
        : undefined,
    };
  }

  // RabbitMQ payloads are already-mapped NuQJobs (camelCase) that have been
  // serialized to JSON, so dates arrive as strings. Revive them here instead
  // of running the payload back through rowToJob (which expects raw DB rows).
  private rabbitRowToJob(row: any): NuQJob<JobData, JobReturnValue> | null {
    if (!row) return null;
    return {
      ...row,
      createdAt: new Date(row.createdAt),
      finishedAt: row.finishedAt ? new Date(row.finishedAt) : undefined,
    };
  }

  private assertPublicationCompatible(
    row: any,
    job: { id: string; data: JobData; options: NuQJobOptions },
  ): void {
    const expectedOwner =
      normalizeOwnerId(job.options.ownerId)?.toLowerCase() ?? null;
    const expectedGroup = job.options.groupId?.toLowerCase() ?? null;
    if (
      canonicalJson(publicationComparableData(row.data)) !==
      canonicalJson(publicationComparableData(job.data))
    ) {
      throw new NuQPublicationConflictError(job.id, "data differs");
    }
    if (row.priority !== (job.options.priority ?? 0)) {
      throw new NuQPublicationConflictError(job.id, "priority differs");
    }
    if ((row.owner_id ?? null) !== expectedOwner) {
      throw new NuQPublicationConflictError(job.id, "owner differs");
    }
    if ((row.group_id ?? null) !== expectedGroup) {
      throw new NuQPublicationConflictError(job.id, "group differs");
    }
    if (!!row.listen_channel_id !== !!job.options.listenable) {
      throw new NuQPublicationConflictError(job.id, "listen mode differs");
    }
    if (!job.options.backlogged && row.backlogged) {
      throw new NuQPublicationConflictError(
        job.id,
        "active publication already exists in backlog",
      );
    }
  }

  private async insertPublicationBatch(
    client: PoolClient,
    jobs: { id: string; data: JobData; options: NuQJobOptions }[],
    backlogged: boolean,
  ): Promise<Set<string>> {
    const inserted = new Set<string>();
    const columns = [
      "id",
      "data",
      "priority",
      "listen_channel_id",
      "owner_id",
      "group_id",
      ...(backlogged ? ["times_out_at"] : []),
    ];

    for (let offset = 0; offset < jobs.length; offset += 1000) {
      const batch = jobs.slice(offset, offset + 1000);
      const params: unknown[] = [];
      const values = batch.map((job, index) => {
        const base = index * columns.length + 1;
        params.push(
          job.id,
          job.data,
          job.options.priority ?? 0,
          job.options.listenable ? this.listenChannelId : null,
          normalizeOwnerId(job.options.ownerId),
          job.options.groupId ?? null,
          ...(backlogged
            ? [job.options.backloggedTimesOutAt?.toISOString() ?? null]
            : []),
        );
        return `(${columns.map((_, column) => `$${base + column}`).join(", ")})`;
      });
      const result = await client.query(
        `INSERT INTO ${this.queueName}${backlogged ? "_backlog" : ""} (${columns.join(", ")}) VALUES ${values.join(", ")} ON CONFLICT (id) DO NOTHING RETURNING id;`,
        params,
      );
      for (const row of result.rows) inserted.add(row.id);
    }
    return inserted;
  }

  private async publishJobsIdempotently(
    jobs: { id: string; data: JobData; options: NuQJobOptions }[],
  ): Promise<{
    jobs: NuQJob<JobData, JobReturnValue>[];
    insertedIds: Set<string>;
  }> {
    if (jobs.length === 0) return { jobs: [], insertedIds: new Set() };
    jobs = jobs.map(job => ({
      ...job,
      id: canonicalUuid(job.id),
      options: {
        ...job.options,
        groupId: job.options.groupId
          ? canonicalUuid(job.options.groupId)
          : undefined,
      },
    }));
    const expectedById = new Map<string, (typeof jobs)[number]>();
    for (const job of jobs) {
      if (expectedById.has(job.id)) {
        throw new NuQPublicationConflictError(job.id, "duplicate input id");
      }
      if (job.options.backlogged && !this.options.backlog) {
        throw new NuQPublicationConflictError(
          job.id,
          "queue does not support backlog publication",
        );
      }
      expectedById.set(job.id, job);
    }

    const ids = [...expectedById.keys()].sort();
    const client = await nuqPool.connect();
    try {
      await client.query("BEGIN");
      // Serialize stable-ID publishers across the active/backlog tables. This
      // closes the gap left by their independent primary keys.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(id, 0)) FROM unnest($1::text[]) AS ids(id) ORDER BY id;`,
        [ids],
      );
      if (this.queueName === "nuq.queue_scrape") {
        await validateNuQPgPublicationUnderLock(ids);
      }

      const readRows = async () => {
        const active = (
          await client.query(
            `SELECT ${this.jobReturning.join(", ")}, false AS backlogged FROM ${this.queueName} WHERE id = ANY($1::uuid[]) FOR UPDATE;`,
            [ids],
          )
        ).rows;
        const backlog = this.options.backlog
          ? (
              await client.query(
                `SELECT ${this.jobBacklogReturning.join(", ")}, true AS backlogged FROM ${this.queueName}_backlog WHERE id = ANY($1::uuid[]) FOR UPDATE;`,
                [ids],
              )
            ).rows
          : [];
        return [...active, ...backlog];
      };

      let rows = await readRows();
      const rowsById = new Map<string, any>();
      for (const row of rows) {
        if (rowsById.has(row.id)) {
          throw new NuQPublicationConflictError(
            row.id,
            "id exists in active and backlog tables",
          );
        }
        rowsById.set(row.id, row);
        this.assertPublicationCompatible(row, expectedById.get(row.id)!);
      }

      const missing = jobs.filter(job => !rowsById.has(job.id));
      const insertedIds = new Set<string>();
      for (const backlogged of [false, true]) {
        const partition = missing.filter(
          job => !!job.options.backlogged === backlogged,
        );
        if (partition.length === 0) continue;
        const inserted = await this.insertPublicationBatch(
          client,
          partition,
          backlogged,
        );
        for (const id of inserted) insertedIds.add(id);
      }

      rows = await readRows();
      rowsById.clear();
      for (const row of rows) {
        if (rowsById.has(row.id)) {
          throw new NuQPublicationConflictError(
            row.id,
            "id exists in active and backlog tables",
          );
        }
        rowsById.set(row.id, row);
        this.assertPublicationCompatible(row, expectedById.get(row.id)!);
      }
      for (const id of ids) {
        if (!rowsById.has(id)) {
          throw new Error(
            `NuQ publication did not materialize stable id ${id}`,
          );
        }
      }

      await client.query("COMMIT");
      return {
        jobs: jobs.map(job => {
          const row = rowsById.get(job.id)!;
          return this.rowToJob(row, row.backlogged)!;
        }),
        insertedIds,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
        const result = this.rowToJob(
          (
            await nuqPool.query(
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
    ids: string[],
    _logger: Logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue>[]> {
    if (ids.length === 0) return [];

    const start = Date.now();
    try {
      return (
        await nuqPool.query(
          `SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.id = ANY($1::uuid[]);`,
          [ids],
        )
      ).rows.map(row => this.rowToJob(row)!);
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
    ids: string[],
    _logger: Logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue>[]> {
    if (ids.length === 0) return [];

    const start = Date.now();
    try {
      return (
        await nuqPool.query(
          `SELECT ${this.jobBacklogReturning.join(", ")} FROM ${this.queueName}_backlog WHERE ${this.queueName}_backlog.id = ANY($1::uuid[]);`,
          [ids],
        )
      ).rows.map(row => this.rowToJob(row, true)!);
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
    ids: string[],
    status: NuQJobStatus,
    _logger: Logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue>[]> {
    if (ids.length === 0) return [];

    const start = Date.now();
    try {
      return (
        await nuqPool.query(
          `SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.id = ANY($1::uuid[]) AND ${this.queueName}.status = $2::nuq.job_status;`,
          [ids, status],
        )
      ).rows.map(row => this.rowToJob(row)!);
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
    ids: string[],
    statuses: NuQJobStatus[],
    _logger: Logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue>[]> {
    if (ids.length === 0) return [];

    const start = Date.now();
    try {
      return (
        await nuqPool.query(
          `SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.id = ANY($1::uuid[]) AND ${this.queueName}.status = ANY($2::nuq.job_status[]);`,
          [ids, statuses],
        )
      ).rows.map(row => this.rowToJob(row)!);
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
    return this.rowToJob(
      (
        await nuqPool.query(
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
      return Object.fromEntries(
        (
          await nuqPool.query(
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
          )
        ).rows.map(row => [row.status, parseInt(row.count, 10)]),
      );
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
  ): Promise<string[]> {
    const start = Date.now();
    try {
      return (
        await nuqPool.query(
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
  ): Promise<string[]> {
    const start = Date.now();
    try {
      return (
        await nuqPool.query(
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

  // TODO: make more generalizable
  public async getCrawlJobsForListing(
    groupId: string,
    limit: number,
    offset: number,
    _logger: Logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue>[]> {
    const start = Date.now();
    try {
      return (
        await nuqPool.query(
          `
            SELECT ${this.jobReturning.join(", ")}
            FROM ${this.queueName}
            WHERE ${this.queueName}.group_id = $1
            AND ${this.queueName}.status = 'completed'
            AND ${this.queueName}.data->>'mode' = 'single_urls'
            ORDER BY finished_at ASC, created_at ASC
            LIMIT $2 OFFSET $3;
          `,
          [groupId, limit, offset],
        )
      ).rows.map(row => this.rowToJob(row)!);
    } finally {
      _logger.info("nuqGetCrawlJobsForListing metrics", {
        module: "nuq/metrics",
        method: "nuqGetCrawlJobsForListing",
        duration: Date.now() - start,
        crawlId: groupId,
      });
    }
  }

  public async removeJobResidue(
    id: string,
    _logger: Logger = logger,
    beforeCommit?: (removed: readonly NuQRemovedJobResidue[]) => Promise<void>,
  ): Promise<NuQRemovedJobResidue | null> {
    return (
      (await this.removeJobsResidue([id], _logger, beforeCommit))[0] ?? null
    );
  }

  public async removeJob(
    id: string,
    _logger: Logger = logger,
  ): Promise<boolean> {
    return (await this.removeJobResidue(id, _logger)) !== null;
  }

  public async removeJobsResidue(
    ids: string[],
    _logger: Logger = logger,
    beforeCommit?: (removed: readonly NuQRemovedJobResidue[]) => Promise<void>,
  ): Promise<NuQRemovedJobResidue[]> {
    if (ids.length === 0) return [];
    ids = [...new Set(ids.map(canonicalUuid))];

    const start = Date.now();
    const client = await nuqPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(id, 0)) FROM unnest($1::text[]) AS ids(id) ORDER BY id;`,
        [[...ids].sort()],
      );
      const active = (
        await client.query(
          `DELETE FROM ${this.queueName} WHERE id = ANY($1::uuid[]) RETURNING id, owner_id, group_id, data;`,
          [ids],
        )
      ).rows;
      const backlog = this.options.backlog
        ? (
            await client.query(
              `DELETE FROM ${this.queueName}_backlog WHERE id = ANY($1::uuid[]) RETURNING id, owner_id, group_id, data;`,
              [ids],
            )
          ).rows
        : [];
      const removed = new Map<string, NuQRemovedJobResidue>();
      for (const row of [...active, ...backlog]) {
        // A corrupt duplicate can exist because the two tables have separate
        // primary keys. Removal is deliberately healing: both rows are gone,
        // and either copy carries enough metadata for Redis cleanup.
        if (!removed.has(row.id)) {
          removed.set(row.id, {
            id: row.id,
            ownerId: row.owner_id ?? undefined,
            groupId: row.group_id ?? undefined,
            data: row.data,
          });
        }
      }
      const result = ids
        .map(id => removed.get(id))
        .filter((row): row is NuQRemovedJobResidue => row !== undefined);
      // The callback runs after DELETE but before COMMIT while the stable-ID
      // advisory locks are still held. Cross-store deletion intent therefore
      // becomes durable before publishers can observe the row as absent.
      if (beforeCommit) await beforeCommit(result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
      _logger.info("nuqRemoveJobs metrics", {
        module: "nuq/metrics",
        method: "nuqRemoveJobs",
        duration: Date.now() - start,
        scrapeIds: ids.length,
      });
    }
  }

  public async removeJobs(
    ids: string[],
    _logger: Logger = logger,
  ): Promise<number> {
    return (await this.removeJobsResidue(ids, _logger)).length;
  }

  // === Producer
  public async addJobWithPublicationState(
    id: string,
    data: JobData,
    options: NuQJobOptions,
  ): Promise<{
    job: NuQJob<JobData, JobReturnValue>;
    inserted: boolean;
  }> {
    const publication = await this.publishJobsIdempotently([
      { id, data, options },
    ]);
    return {
      job: publication.jobs[0]!,
      inserted: publication.insertedIds.has(canonicalUuid(id)),
    };
  }

  public async addJobsWithPublicationState(
    jobs: Array<{
      id: string;
      data: JobData;
      options: NuQJobOptions;
    }>,
  ): Promise<{
    jobs: NuQJob<JobData, JobReturnValue>[];
    insertedIds: Set<string>;
  }> {
    return await this.publishJobsIdempotently(jobs);
  }

  public async addJob(
    id: string,
    data: JobData,
    options: NuQJobOptions,
  ): Promise<NuQJob<JobData, JobReturnValue>> {
    return withSpan("nuq.addJob", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
        "nuq.priority": options.priority ?? 0,
        "nuq.zero_data_retention": (data as any)?.zeroDataRetention ?? false,
        "nuq.listenable": options.listenable ?? false,
      });

      const start = Date.now();
      try {
        const result = (
          await this.publishJobsIdempotently([{ id, data, options }])
        ).jobs[0]!;

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
          zeroDataRetention: (data as any)?.zeroDataRetention ?? false,
        });
      }
    });
  }

  public async addJobIfNotExists(
    id: string,
    data: JobData,
    options: NuQJobOptions,
  ): Promise<NuQJob<JobData, JobReturnValue> | null> {
    return withSpan("nuq.addJob", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
        "nuq.priority": options.priority ?? 0,
        "nuq.zero_data_retention": (data as any)?.zeroDataRetention ?? false,
        "nuq.listenable": options.listenable ?? false,
      });

      const start = Date.now();
      try {
        const publication = await this.publishJobsIdempotently([
          { id, data, options },
        ]);
        const result = publication.insertedIds.has(canonicalUuid(id))
          ? publication.jobs[0]
          : null;

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
          zeroDataRetention: (data as any)?.zeroDataRetention ?? false,
        });
      }
    });
  }

  public async addJobs(
    jobs: Array<{
      id: string;
      data: JobData;
      options: NuQJobOptions;
    }>,
  ): Promise<NuQJob<JobData, JobReturnValue>[]> {
    return withSpan("nuq.addJobs", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.jobs_count": jobs.length,
      });

      if (jobs.length === 0) {
        return [];
      }

      const start = Date.now();
      try {
        const regularJobs = jobs.filter(job => !job.options.backlogged);
        const backloggedJobs = jobs.filter(job => job.options.backlogged);
        const results = (await this.publishJobsIdempotently(jobs)).jobs;

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
    });
  }

  public async promoteJobFromBacklogOrAdd(
    id: string,
    data: JobData,
    options: NuQJobOptions,
  ): Promise<NuQJob<JobData, JobReturnValue> | null> {
    return withSpan("nuq.promoteJobFromBacklogOrAdd", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
        "nuq.priority": options.priority ?? 0,
        "nuq.zero_data_retention": (data as any)?.zeroDataRetention ?? false,
        "nuq.listenable": options.listenable ?? false,
      });

      const start = Date.now();
      id = canonicalUuid(id);
      const client = await nuqPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0));`,
          [id],
        );
        let result = this.rowToJob(
          (
            await client.query(
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

        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
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
    });
  }

  private readonly nuqWaitMode =
    config.NUQ_WAIT_MODE === "listen" || config.NUQ_RABBITMQ_URL
      ? ("listen" as const)
      : ("poll" as const);

  public waitForJob(
    id: string,
    timeout: number | null,
    _logger: Logger = logger,
  ): Promise<JobReturnValue> {
    return withSpan("nuq.waitForJob", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
        "nuq.timeout": timeout ?? undefined,
        "nuq.wait_mode": this.nuqWaitMode,
      });

      const startTime = Date.now();

      const done = new Promise<JobReturnValue>(
        (async (resolve, reject) => {
          if (this.nuqWaitMode === "listen") {
            let timer: NodeJS.Timeout | null = null;
            if (timeout !== null) {
              timer = setTimeout(
                (() => {
                  this.removeListener(id, listener);
                  reject(new Error("Timed out"));
                }).bind(this),
                timeout,
              );
            }

            const listener = async function (_msg: "completed" | "failed") {
              if (timer) clearTimeout(timer);
              const job = await this.getJob(id, _logger);
              if (!job) {
                reject(new Error("Job raced out while waiting for it"));
              } else {
                if (job.status === "completed") {
                  resolve(job.returnvalue!);
                } else {
                  reject(new Error(job.failedReason!));
                }
              }
            }.bind(this);

            try {
              await this.addListener(id, listener);
            } catch (e) {
              reject(e);
            }

            try {
              const job = await this.getJob(id, _logger);
              if (job && ["completed", "failed"].includes(job.status)) {
                this.removeListener(id, listener);
                if (timer) clearTimeout(timer);
                if (job.status === "completed") {
                  resolve(job.returnvalue!);
                } else {
                  reject(new Error(job.failedReason!));
                }
                return;
              }
            } catch (e) {
              _logger.warn("nuqGetJob ensure check failed", {
                module: "nuq",
                method: "nuqWaitForJob",
                error: e,
                scrapeId: id,
              });
            }
          } else {
            const timeoutAt = timeout !== null ? Date.now() + timeout : null;
            const poll = async function poll() {
              try {
                const job = await this.getJob(id, _logger);
                if (job && ["completed", "failed"].includes(job.status)) {
                  if (job.status === "completed") {
                    return resolve(job.returnvalue!);
                  } else {
                    return reject(new Error(job.failedReason!));
                  }
                }
              } catch (e) {
                return reject(e);
              }

              if (timeoutAt && Date.now() > timeoutAt) {
                return reject(new Error("Timed out"));
              }

              setTimeout(poll.bind(this), 500);
            }.bind(this);

            poll();
          }
        }).bind(this),
      );

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
        await nuqPool.query(
          `
            WITH next AS (SELECT id FROM ${this.queueName} WHERE ${this.queueName}.status = 'queued'::nuq.job_status ORDER BY ${this.queueName}.priority ASC, ${this.queueName}.created_at ASC FOR UPDATE SKIP LOCKED LIMIT 500)
            UPDATE ${this.queueName} q SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now() FROM next WHERE q.id = next.id RETURNING ${this.jobReturning.map(x => `q.${x}`).join(", ")};
          `,
        )
      ).rows.map(row => this.rowToJob(row)!);

      for (const job of jobs) {
        await this.sendJobPrefetch(
          job,
          _logger.child({
            jobId: job.id,
            zeroDataRetention: !!(job.data || ({} as any)).zeroDataRetention,
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

  public async getJobToProcess(): Promise<NuQJob<any, any> | null> {
    const start = Date.now();
    try {
      if (config.NUQ_RABBITMQ_URL) {
        await this.startSender();

        if (this.sender) {
          try {
            const job = await this.sender.channel.get(
              this.queueName + ".prefetch",
              { noAck: true },
            );
            if (job !== false) {
              return this.rabbitRowToJob(JSON.parse(job.content.toString()));
            } else {
              return null;
            }
          } catch (err) {
            logger.warn("NuQ sender get failed, falling back to postgres", {
              module: "nuq/rabbitmq",
              err,
            });
            // Reset sender so it can be re-established on next call
            this.sender = null;
          }
        } else {
          logger.warn("NuQ sender not started, falling back to postgres", {
            module: "nuq/rabbitmq",
          });
        }
      }

      return this.rowToJob(
        (
          await nuqPool.query(
            `
              WITH next AS (SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.status = 'queued'::nuq.job_status ORDER BY ${this.queueName}.priority ASC, ${this.queueName}.created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1)
              UPDATE ${this.queueName} q SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now() FROM next WHERE q.id = next.id RETURNING ${this.jobReturning.map(x => `q.${x}`).join(", ")};
            `,
          )
        ).rows[0],
      )!;
    } finally {
      logger.info("nuqGetJobToProcess metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobToProcess",
        duration: Date.now() - start,
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
    returnvalue: any | null,
    _logger: Logger = logger,
  ): Promise<boolean> {
    return withSpan("nuq.jobFinish", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
      });

      const start = Date.now();
      try {
        const result = await nuqPool.query(
          `UPDATE ${this.queueName} SET status = 'completed'::nuq.job_status, lock = null, locked_at = null, finished_at = now(), returnvalue = $3 WHERE id = $1 AND lock = $2 RETURNING id, listen_channel_id;`,
          [id, lock, returnvalue],
        );

        const success = result.rowCount !== 0;

        if (success) {
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

        if (
          this.queueName === "scrape" ||
          this.queueName === "crawl_finished"
        ) {
          const terminal =
            success ||
            ["completed", "failed"].includes(
              (await this.getJob(id, _logger))?.status ?? "",
            );
          if (terminal) {
            await retireNuQPgObject(
              this.queueName === "scrape" ? "scrape_job" : "crawl_finished",
              id,
            );
          }
        }
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
        const result = await nuqPool.query(
          `UPDATE ${this.queueName} SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, finished_at = now(), failedreason = $3 WHERE id = $1 AND lock = $2 RETURNING id, listen_channel_id;`,
          [id, lock, failedReason],
        );

        const success = result.rowCount !== 0;

        if (success) {
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

        if (
          this.queueName === "scrape" ||
          this.queueName === "crawl_finished"
        ) {
          const terminal =
            success ||
            ["completed", "failed"].includes(
              (await this.getJob(id, _logger))?.status ?? "",
            );
          if (terminal) {
            await retireNuQPgObject(
              this.queueName === "scrape" ? "scrape_job" : "crawl_finished",
              id,
            );
          }
        }
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
    const result = await nuqPool.query(`
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

    result.rows.forEach(x => statusCounts.set(x.status, parseInt(x.count, 10)));

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

  private rowToGroup(row: any): NuQJobGroupInstance | null {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      createdAt: new Date(row.created_at),
      ownerId: row.owner_id,
      ttl: Number(row.ttl),
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    };
  }

  private assertPublicationCompatible(
    row: any,
    id: string,
    ownerId: string,
    ttl: number,
  ): void {
    if ((row.owner_id ?? null) !== normalizeOwnerId(ownerId)?.toLowerCase()) {
      throw new NuQGroupPublicationConflictError(id, "owner differs");
    }
    if (Number(row.ttl) !== ttl) {
      throw new NuQGroupPublicationConflictError(id, "ttl differs");
    }
  }

  private async readPublicationWithLock(
    client: PoolClient,
    id: string,
  ): Promise<any | null> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0));",
      [canonicalUuid(id)],
    );
    return (
      (
        await client.query(
          `SELECT ${this.groupReturning.join(", ")} FROM ${this.groupName} WHERE id = $1 FOR UPDATE;`,
          [canonicalUuid(id)],
        )
      ).rows[0] ?? null
    );
  }

  public async resolveGroupPublication(
    id: string,
  ): Promise<NuQJobGroupInstance | null> {
    const client = await nuqPool.connect();
    try {
      await client.query("BEGIN");
      const row = await this.readPublicationWithLock(client, id);
      await client.query("COMMIT");
      return this.rowToGroup(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  public async addGroup(
    id: string,
    ownerId: string,
    ttl?: number,
    _logger: Logger = logger,
  ): Promise<NuQJobGroupInstance> {
    return withSpan("nuq.addGroup", async span => {
      const stableId = canonicalUuid(id);
      const stableTtl = ttl ?? 86400000;
      setSpanAttributes(span, {
        "nuq.group_name": this.groupName,
        "nuq.group_id": stableId,
        "nuq.ttl": stableTtl,
      });

      const start = Date.now();
      const client = await nuqPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0));",
          [stableId],
        );
        const inserted = await client.query(
          `INSERT INTO ${this.groupName} (id, owner_id, ttl) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id;`,
          [stableId, normalizeOwnerId(ownerId), stableTtl],
        );
        const row = (
          await client.query(
            `SELECT ${this.groupReturning.join(", ")} FROM ${this.groupName} WHERE id = $1 FOR UPDATE;`,
            [stableId],
          )
        ).rows[0];
        if (!row) {
          throw new Error(
            `NuQ group publication did not materialize stable id ${stableId}`,
          );
        }
        this.assertPublicationCompatible(row, stableId, ownerId, stableTtl);
        await client.query("COMMIT");
        const result = this.rowToGroup(row)!;

        setSpanAttributes(span, {
          "nuq.group_created": inserted.rowCount === 1,
        });
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        _logger.info("nuqAddGroup metrics", {
          module: "nuq/metrics",
          method: "nuqAddGroup",
          duration,
          groupId: stableId,
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
        const result = this.rowToGroup(
          (
            await nuqPool.query(
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
  ): Promise<NuQJobGroupInstance[]> {
    return withSpan("nuq.getGroupByOwner", async span => {
      setSpanAttributes(span, {
        "nuq.group_name": this.groupName,
        "nuq.owner_id": ownerId,
      });

      const start = Date.now();
      try {
        const result = (
          await nuqPool.query(
            `SELECT ${this.groupReturning.join(", ")} FROM ${this.groupName} WHERE ${this.groupName}.owner_id = $1 AND ${this.groupName}.status = 'active'`,
            [normalizeOwnerId(ownerId)],
          )
        ).rows.map(x => this.rowToGroup(x)!);

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
          ownerId: ownerId,
        });
      }
    });
  }
}

export async function getNuQPgOwnerLiveResidue(
  ownerId: string,
): Promise<NuQPgOwnerLiveResidue> {
  const normalizedOwnerId = normalizeOwnerId(ownerId);
  const row = (
    await nuqPool.query(
      `SELECT
         (SELECT count(*)::int FROM nuq.queue_scrape
          WHERE owner_id = $1 AND status IN ('queued', 'active')) AS scrape,
         (SELECT count(*)::int FROM nuq.queue_scrape_backlog
          WHERE owner_id = $1) AS backlog,
         (SELECT count(*)::int FROM nuq.group_crawl
          WHERE owner_id = $1 AND status = 'active') AS groups,
         (SELECT count(*)::int FROM nuq.queue_crawl_finished
          WHERE owner_id = $1 AND status IN ('queued', 'active')) AS crawl_finished;`,
      [normalizedOwnerId],
    )
  ).rows[0] as {
    scrape: number;
    backlog: number;
    groups: number;
    crawl_finished: number;
  };
  const result = {
    scrape: Number(row.scrape),
    backlog: Number(row.backlog),
    groups: Number(row.groups),
    crawlFinished: Number(row.crawl_finished),
    total: 0,
  };
  result.total =
    result.scrape + result.backlog + result.groups + result.crawlFinished;
  return result;
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

export const scrapeQueue = new NuQ<ScrapeJobData>("nuq.queue_scrape", {
  backlog: true,
});
export const crawlFinishedQueue = new NuQ("nuq.queue_crawl_finished", {});

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
