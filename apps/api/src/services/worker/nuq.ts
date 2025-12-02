import { Logger } from "winston";
import { logger } from "../../lib/logger";
import { Client, Pool } from "pg";
import { type ScrapeJobData } from "../../types";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import amqp from "amqplib";
import { v5 as uuidv5, validate as isUUID } from "uuid";

// === Basics

const nuqPool = new Pool({
  connectionString: process.env.NUQ_DATABASE_URL, // may be a pgbouncer transaction pooler URL
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
};

type NuQJobOptions = {
  priority?: number;
  listenable?: boolean;
  ownerId?: string;
  groupId?: string;
  backlogged?: boolean;
  backloggedTimesOutAt?: Date;
};

type NuQOptions = {
  backlog?: boolean;
};

// owner IDs can sometimes be non-UUID, so let's normalize it to avoid query breakage - mogery
const normalizedUUIDNamespace = "0f38e00e-d7ee-4b77-8a7a-a787a3537ca2";
function normalizeOwnerId(ownerId: string | undefined | null): string | null {
  if (typeof ownerId !== "string") return null;
  if (isUUID(ownerId)) return ownerId;
  return uuidv5(ownerId, normalizedUUIDNamespace);
}

// === Queue

class NuQ<JobData = any, JobReturnValue = any> {
  private listenChannelId: string =
    (process.env.NUQ_POD_NAME ?? "main") + "-" + crypto.randomUUID();

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

    if (process.env.NUQ_RABBITMQ_URL) {
      this.listenerStarting = true;

      try {
        const connection = await amqp.connect(process.env.NUQ_RABBITMQ_URL);
        const channel = await connection.createChannel();
        await channel.prefetch(1);
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
      this.listener = {
        type: "postgres",
        client: new Client({
          connectionString:
            process.env.NUQ_DATABASE_URL_LISTEN ?? process.env.NUQ_DATABASE_URL, // will always be a direct connection
          application_name: "nuq_listener",
        }),
      };

      this.listener.client.on("notification", msg => {
        const tok = (msg.payload ?? "unknown|unknown").split("|");
        if (tok[0] in this.listens) {
          this.listens[tok[0]].forEach(listener =>
            listener(tok[1] as "completed" | "failed"),
          );
          delete this.listens[tok[0]];
        }
      });

      this.listener.client.on("error", err =>
        logger.error("Error in NuQ listener", { err, module: "nuq" }),
      );

      this.listener.client.on("end", () => {
        logger.info("NuQ listener disconnected", { module: "nuq" });
        this.listener = null;
        setTimeout(
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

  private async startSender() {
    if (this.sender || this.shuttingDown) return;

    if (process.env.NUQ_RABBITMQ_URL) {
      const connection = await amqp.connect(process.env.NUQ_RABBITMQ_URL);
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
        connection.close().catch(() => {});
        this.sender = null;
      });

      connection.on("close", () => {
        logger.info("NuQ sender connection closed", { module: "nuq/rabbitmq" });
        this.sender = null;
      });
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
          expiration: "15000", // has to expire in 15s otherwise locks will fail to be acquired for jobs that got picked up late
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

  public async getBackloggedJobIDsOfOnwer(
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
      _logger.info("nuqGetBackloggedJobIDsOfOnwer metrics", {
        module: "nuq/metrics",
        method: "nuqGetBackloggedJobIDsOfOnwer",
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
    ids: string[],
    _logger: Logger = logger,
  ): Promise<number> {
    if (ids.length === 0) return 0;

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
        const result = this.rowToJob(
          (
            await nuqPool.query(
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
          ).rows[0],
        )!;

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
        const result = this.rowToJob(
          (
            await nuqPool.query(
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

        const results: NuQJob<JobData, JobReturnValue>[] = [];

        // Batch size: 6 params per job, stay well under PG's 65535 param limit
        // 1000 jobs = 6000 params, leaving plenty of headroom
        const BATCH_SIZE = 1000;

        // Helper function to build and execute bulk insert with batching
        const bulkInsert = async (
          jobsToInsert: typeof jobs,
          tableSuffix: string,
        ) => {
          if (jobsToInsert.length === 0) return;

          // Process in batches
          for (
            let offset = 0;
            offset < jobsToInsert.length;
            offset += BATCH_SIZE
          ) {
            const batch = jobsToInsert.slice(offset, offset + BATCH_SIZE);

            // Build the VALUES clause and parameters array
            const valuesPlaceholders: string[] = [];
            const params: any[] = [];

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
                ...[
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
                ],
              );
            }

            const query = `INSERT INTO ${this.queueName}${tableSuffix} (${columns.join(", ")}) VALUES ${valuesPlaceholders.join(", ")} RETURNING ${(tableSuffix === "_backlog" ? this.jobBacklogReturning : this.jobReturning).join(", ")};`;

            const result = await nuqPool.query(query, params);

            // Convert rows to jobs and maintain order
            const jobMap = new Map(
              result.rows.map(row => [
                row.id,
                this.rowToJob(row, tableSuffix === "_backlog")!,
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
      try {
        const result = this.rowToJob(
          (
            await nuqPool.query(
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
    });
  }

  private readonly nuqWaitMode =
    process.env.NUQ_WAIT_MODE === "listen" || process.env.NUQ_RABBITMQ_URL
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
      if (process.env.NUQ_RABBITMQ_URL) {
        await this.startSender();

        if (this.sender) {
          const job = await this.sender.channel.get(
            this.queueName + ".prefetch",
            { noAck: true },
          );
          if (job !== false) {
            return this.rowToJob(JSON.parse(job.content.toString()));
          } else {
            return null;
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
          if (this.nuqWaitMode === "listen" && !process.env.NUQ_RABBITMQ_URL) {
            await nuqPool.query(`SELECT pg_notify('${this.queueName}', $1);`, [
              job.id + "|completed",
            ]);
          } else if (process.env.NUQ_RABBITMQ_URL && job.listen_channel_id) {
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
        const result = await nuqPool.query(
          `UPDATE ${this.queueName} SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, finished_at = now(), failedreason = $3 WHERE id = $1 AND lock = $2 RETURNING id, listen_channel_id;`,
          [id, lock, failedReason],
        );

        const success = result.rowCount !== 0;

        if (success) {
          const job = result.rows[0];
          if (this.nuqWaitMode === "listen" && !process.env.NUQ_RABBITMQ_URL) {
            await nuqPool.query(`SELECT pg_notify('${this.queueName}', $1);`, [
              job.id + "|failed",
            ]);
          } else if (process.env.NUQ_RABBITMQ_URL && job.listen_channel_id) {
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
        await nl.channel.cancel(nl.queue);
        await nl.channel.close();
        await nl.connection.close();
      }
    }
    if (this.sender) {
      const ns = this.sender;
      this.sender = null;
      await ns.channel.close();
      await ns.connection.close();
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
      ttl: row.ttl,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    };
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
        "nuq.ttl": ttl ?? 86400000,
      });

      const start = Date.now();
      try {
        const result = this.rowToGroup(
          (
            await nuqPool.query(
              `INSERT INTO ${this.groupName} (id, owner_id, ttl) VALUES ($1, $2, $3) RETURNING ${this.groupReturning.join(", ")};`,
              [id, normalizeOwnerId(ownerId), ttl ?? 86400000],
            )
          ).rows[0],
        )!;

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
  await scrapeQueue.shutdown();
  await nuqPool.end();
}
