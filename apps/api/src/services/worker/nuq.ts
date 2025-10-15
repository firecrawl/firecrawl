import { Logger } from "winston";
import { logger } from "../../lib/logger";
import { Client, Pool } from "pg";
import { type ScrapeJobData } from "../../types";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import amqp from "amqplib";

// === Basics

const nuqPool = new Pool({
  connectionString: process.env.NUQ_DATABASE_URL, // may be a pgbouncer transaction pooler URL
  application_name: "nuq",
});

nuqPool.on("error", err =>
  logger.error("Error in NuQ idle client", { err, module: "nuq" }),
);

export type NuQJobStatus = "queued" | "active" | "completed" | "failed"; // must match nuq.job_status enum
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
};

const listenChannelId = process.env.NUQ_POD_NAME ?? "main";

// === Queue

class NuQ<JobData = any, JobReturnValue = any> {
  constructor(public readonly queueName: string) {}

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
  private shuttingDown = false;

  private async startListener() {
    if (this.listener || this.shuttingDown) return;

    if (process.env.NUQ_RABBITMQ_URL) {
      const connection = await amqp.connect(process.env.NUQ_RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.prefetch(1);
      const queue = await channel.assertQueue(
        this.queueName + ".listen." + listenChannelId,
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

      let reconnectTimeout: NodeJS.Timeout | null = null;

      const onClose = (function onClose() {
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
      }).bind(this);

      connection.on("close", onClose);
      channel.on("close", onClose);

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
      await this.sender.channel.sendToQueue(
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
      await this.sender.channel.sendToQueue(
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
  ];

  private rowToJob(row: any): NuQJob<JobData, JobReturnValue> | null {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      createdAt: new Date(row.created_at),
      priority: row.priority,
      data: row.data,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
      listenChannelId: row.listen_channel_id ?? undefined,
      returnvalue: row.returnvalue ?? undefined,
      failedReason: row.failedreason ?? undefined,
      lock: row.lock ?? undefined,
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
    priority: number = 0,
    listenable: boolean = false,
  ): Promise<NuQJob<JobData, JobReturnValue>> {
    return withSpan("nuq.addJob", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
        "nuq.priority": priority,
        "nuq.zero_data_retention": (data as any)?.zeroDataRetention ?? false,
        "nuq.listenable": listenable,
      });

      const start = Date.now();
      try {
        const result = this.rowToJob(
          (
            await nuqPool.query(
              `INSERT INTO ${this.queueName} (id, data, priority, listen_channel_id) VALUES ($1, $2, $3, $4) RETURNING ${this.jobReturning.join(", ")};`,
              [id, data, priority, listenable ? listenChannelId : null],
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
    const result = await nuqPool.query(
      `SELECT status, COUNT(id) as count FROM ${this.queueName} GROUP BY status ORDER BY count DESC;`,
    );
    logger.info("nuqGetMetrics metrics", {
      module: "nuq/metrics",
      method: "nuqGetMetrics",
      duration: Date.now() - start,
    });
    const prometheusQueueName = this.queueName.replace(".", "_");
    return `# HELP ${prometheusQueueName}_job_count Number of jobs in each status\n# TYPE ${prometheusQueueName}_job_count gauge\n${result.rows.map(x => `${prometheusQueueName}_job_count{status="${x.status}"} ${x.count}`).join("\n")}\n`;
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

export const scrapeQueue = new NuQ<ScrapeJobData>("nuq.queue_scrape");

// === Cleanup

export async function nuqShutdown() {
  await scrapeQueue.shutdown();
  await nuqPool.end();
}
