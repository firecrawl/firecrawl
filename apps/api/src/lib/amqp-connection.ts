import amqp from "amqplib";
import { config } from "../config";
import { logger } from "./logger";

type Session = {
  connection: amqp.ChannelModel;
  channel: amqp.Channel;
};

export function isTransientAmqpError(error: unknown): boolean {
  const code = (error as { code?: string | number })?.code;
  return !(
    [
      403,
      406,
      530,
      "ACCESS_REFUSED",
      "PRECONDITION_FAILED",
      "EINVAL",
      "ERR_INVALID_URL",
    ].includes(code!) ||
    (error instanceof Error &&
      /ACCESS[_-]REFUSED|PRECONDITION[_-]FAILED|NOT[_-]ALLOWED|URL is not configured|Invalid URL/i.test(
        error.message,
      ))
  );
}

export class AmqpConnection {
  private session: Session | null = null;
  private connecting: Promise<Session> | null = null;
  private provisional: Partial<Session> | null = null;
  private cancelAttempt: ((error: Error) => void) | null = null;
  private stopped = false;
  private permanentError: unknown = null;
  private retryDelay = 250;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: () => string | undefined,
    private readonly name: string,
    private readonly setup: (
      channel: amqp.Channel,
      invalidate: () => void,
    ) => Promise<void>,
  ) {}

  get current(): Session | null {
    return this.session;
  }

  ensure(): void {
    if (this.permanentError) throw this.permanentError;
    if (
      !this.stopped &&
      !this.session &&
      !this.connecting &&
      !this.retryTimer &&
      !this.permanentError
    )
      void this.connect().catch(() => {});
  }

  connect(): Promise<Session> {
    if (this.stopped)
      return Promise.reject(new Error(`${this.name} is closed`));
    if (this.permanentError) return Promise.reject(this.permanentError);
    if (this.session) return Promise.resolve(this.session);
    if (this.connecting) return this.connecting;
    if (this.retryTimer)
      return Promise.reject(
        Object.assign(new Error(`${this.name} reconnecting`), {
          code: "ECONNREFUSED",
        }),
      );
    const pending = this.open()
      .catch(error => {
        if (!this.stopped) {
          if (isTransientAmqpError(error)) {
            logger.warn(`${this.name} connection failed`, { error });
            this.reconnect();
          } else {
            this.permanentError = error;
            logger.error(
              `${this.name} setup failed permanently; recovery disabled, check configuration`,
              { error },
            );
          }
        }
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });
    this.connecting = pending;
    return pending;
  }

  private reconnect(error?: unknown) {
    if (this.stopped || this.retryTimer || this.permanentError) return;
    const delay = this.retryDelay;
    logger.warn(`${this.name} reconnecting`, { error, retryDelayMs: delay });
    this.retryDelay = Math.min(delay * 2, 10000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.ensure();
    }, delay);
    this.retryTimer.unref();
  }

  private async dispose(resources: Partial<Session>): Promise<void> {
    const { channel, connection } = resources;
    delete resources.channel;
    delete resources.connection;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([
        Promise.resolve()
          .then(() => channel?.close())
          .catch(() => {}),
        Promise.resolve()
          .then(() => connection?.close())
          .catch(() => {}),
      ]),
      new Promise<void>(resolve => {
        timer = setTimeout(() => {
          (
            connection?.connection as
              | (amqp.Connection & { stream: { destroy(): void } })
              | undefined
          )?.stream.destroy();
          resolve();
        }, 1000);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private async open(): Promise<Session> {
    const resources: Partial<Session> = {};
    this.provisional = resources;
    let cancelled = false;
    let failure: Error | null = null;
    let timer: NodeJS.Timeout | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      this.cancelAttempt = reject;
      timer = setTimeout(
        () =>
          reject(
            Object.assign(new Error(`${this.name} setup timed out`), {
              code: "ETIMEDOUT",
            }),
          ),
        config.AMQP_SETUP_TIMEOUT_MS,
      );
    });
    const invalidate = () => {
      if (cancelled) return;
      if (this.session?.connection === resources.connection) {
        this.session = null;
        cancelled = true;
        void this.dispose(resources);
        this.reconnect(failure ?? new Error(`${this.name} session closed`));
      } else {
        this.cancelAttempt?.(
          failure ??
            Object.assign(
              new Error(`${this.name} connection closed during setup`),
              { code: "ECONNRESET" },
            ),
        );
      }
    };
    const opened = (async () => {
      const url = this.url();
      if (!url) throw new Error(`${this.name} URL is not configured`);
      const connection = await amqp.connect(url, {
        timeout: config.AMQP_SETUP_TIMEOUT_MS,
      });
      resources.connection = connection;
      connection.on("error", error => {
        failure = error;
        invalidate();
      });
      connection.on("close", invalidate);
      if (cancelled || this.stopped) {
        await this.dispose(resources);
        throw new Error(`${this.name} is closed`);
      }
      const channel = await connection.createChannel();
      resources.channel = channel;
      channel.on("error", error => {
        failure = error;
        invalidate();
      });
      channel.on("close", invalidate);
      if (cancelled || this.stopped) {
        await this.dispose(resources);
        throw new Error(`${this.name} is closed`);
      }
      await this.setup(channel, invalidate);
      if (cancelled || this.stopped) throw new Error(`${this.name} is closed`);
      return { connection, channel };
    })();
    try {
      const session = await Promise.race([opened, interrupted]);
      this.session = session;
      this.retryDelay = 250;
      logger.info(`${this.name} connected`);
      return session;
    } catch (error) {
      cancelled = true;
      void this.dispose(resources);
      throw error;
    } finally {
      clearTimeout(timer);
      this.cancelAttempt = null;
      this.provisional = null;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.cancelAttempt?.(new Error(`${this.name} is closed`));
    const resources = this.provisional ?? this.session;
    this.session = null;
    if (resources) await this.dispose(resources);
  }
}
