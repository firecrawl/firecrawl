/**
 * Default open-source module implementations.
 *
 * This file imports only module types so constructing default modules or
 * describing a service never loads configuration, queues, or storage clients.
 */
import type { z as Zod } from "zod";
import type { Document } from "../controllers/v2/types";
import type { safeParseLogged as SafeParseLogged } from "../lib/zod-log";
import type { JobKind } from "./hooks";
import type {
  AuthModule,
  BillingModule,
  BlocklistModule,
  FetchProxyFileKind,
  IdempotencyModule,
  JobOutcome,
  JobOwner,
  JobRecord,
  JobStoreModule,
  JobUsageOptions,
  LimitsModule,
  MessagesModule,
  Modules,
  PolicyModule,
  StoredJob,
  UploadDriver,
  UploadsModule,
  WebhooksModule,
} from "./modules";
import type { Redis } from "ioredis";
import type { BaseCaller, BaseRequestContext } from "./request-context";

/**
 * Default authentication module that admits every request under a single fixed
 * team id. Typed on `BaseCaller` so widening `Caller` rejects it at compile
 * time.
 */
export function openAuth(teamId = "bypass"): AuthModule<BaseCaller> {
  return {
    authenticate: async () => ({ ok: true, caller: { teamId } }),
  };
}

/** Empty blocklist that initializes as a no-op and allows every URL. */
export function noBlocklist(): BlocklistModule {
  return {
    async init() {},
    isBlocked: () => false,
    hasScopedRules: () => false,
  };
}

/** Default limits module: unlimited concurrency, base priority, and configured queue backend. */
export function noLimits(): LimitsModule {
  return {
    concurrency: async () => null,
    teamConcurrency: async () => null,
    jobPriority: async ({ base }) => base,
    queueBackend: () => undefined,
  };
}

/** Default billing module: authorizes every request and records no charges. */
export function unmeteredBilling(): BillingModule {
  return {
    async authorize() {
      return { ok: true };
    },
    async charge() {
      return undefined;
    },
  };
}

/** Default user-facing messages that direct operators to local logs and config. */
export function logsMessages(): MessagesModule {
  return {
    errorContact(errorId?: string): string {
      return errorId
        ? `An error occurred. Please check your logs for more details. Error ID: ${errorId}`
        : "An error occurred. Please check your logs for more details.";
    },
    restrictedCountryContact(): string {
      return "Please check your server configuration.";
    },
    allEnginesFailedContact(): string {
      return "Check your server logs for more detailed error information from each engine.";
    },
    fileFetchProxyError(kind: FetchProxyFileKind): string {
      return `Failed to download the ${kind} file because the configured proxy could not establish a connection to the website (the proxy rejected the tunneling request). Check your proxy configuration (PROXY_SERVER) and whether the target site is reachable from it, then retry.`;
    },
    filePrefetchFailedContact(): string {
      return "Check your server logs for more details about the specific protection mechanism encountered.";
    },
  };
}

type LocalUploadRecord = {
  buffer?: Buffer;
  filename: string;
  contentType?: string;
  teamId: string;
  expiresAt: number;
  maxBytes: number;
};

/**
 * In-memory upload storage for single-instance deployments.
 * Multi-instance or restart-durable deployments should supply a shared
 * `UploadsModule` implementation to `createService`.
 */
export function memoryUploads(): UploadsModule {
  const localUploads = new Map<string, LocalUploadRecord>();

  const cleanupExpired = (now = Date.now()) => {
    for (const [uploadId, record] of localUploads.entries()) {
      if (now > record.expiresAt) {
        localUploads.delete(uploadId);
      }
    }
  };

  const driver: UploadDriver = {
    name: "local",

    async prepareUpload(input) {
      cleanupExpired();
      const baseUrl = input.publicBaseUrl.replace(/\/$/, "");
      return {
        ok: true,
        target: {
          uploadUrl: `${baseUrl}/v2/parse/upload/${input.uploadId}?uploadRef=${encodeURIComponent(input.uploadRef)}`,
          method: "PUT",
          headers: {
            "Content-Type": input.contentType || "application/octet-stream",
          },
        },
        commit() {
          localUploads.set(input.uploadId, {
            filename: input.filename,
            contentType: input.contentType,
            teamId: input.teamId,
            expiresAt: input.expiresAt,
            maxBytes: input.maxBytes,
          });
        },
      };
    },

    async receiveUpload(input) {
      cleanupExpired();
      const record = localUploads.get(input.uploadId);
      if (!record || record.teamId !== input.teamId) {
        return {
          ok: false,
          status: 404,
          code: "NOT_FOUND",
          error: "Upload URL not found or expired.",
        };
      }
      if (input.body.length > record.maxBytes) {
        return {
          ok: false,
          status: 400,
          code: "BAD_REQUEST",
          error: "Uploaded file exceeds maximum size of 50MB.",
        };
      }
      record.buffer = input.body;
      return { ok: true };
    },

    async read(ref) {
      cleanupExpired();
      const record = localUploads.get(ref.uploadId);
      if (!record || record.teamId !== ref.teamId || !record.buffer) {
        throw new Error(
          "Uploaded file is not available. Upload the file before parsing.",
        );
      }
      if (record.buffer.length > ref.maxBytes) {
        throw new Error("Uploaded file exceeds maximum size of 50MB.");
      }
      return record.buffer;
    },

    async delete(ref) {
      localUploads.delete(ref.uploadId);
    },
  };

  return { driver: () => driver };
}

function buildQueueJobStoreSchemas(
  z: typeof Zod,
  safeParseLogged: typeof SafeParseLogged,
) {
  const storedDocumentShapeSchema = z.looseObject({});
  return {
    safeParseLogged,
    singleUrlJobDataSchema: z.object({
      mode: z.literal("single_urls"),
      team_id: z
        .string()
        .nullish()
        .transform(value => value ?? undefined),
    }),
    singleUrlModeSchema: z.object({
      mode: z.literal("single_urls"),
    }),
    storedDocumentSchema: z.custom<Document>(
      value =>
        safeParseLogged(
          storedDocumentShapeSchema,
          value,
          "queue-job-store.document",
        ).success,
    ),
  };
}

let queueJobStoreSchemasPromise: Promise<
  ReturnType<typeof buildQueueJobStoreSchemas>
> | null = null;

function getQueueJobStoreSchemas() {
  queueJobStoreSchemasPromise ??= Promise.all([
    import("zod"),
    import("../lib/zod-log.js"),
  ]).then(([{ z }, { safeParseLogged }]) =>
    buildQueueJobStoreSchemas(z, safeParseLogged),
  );
  return queueJobStoreSchemasPromise;
}

/**
 * Default open-source job store backed by the job queue and Redis crawl state.
 * Registration, terminal recording, and removal are no-ops because finished
 * queue payloads stay inline; usage returns null.
 */
export function queueJobStore(): JobStoreModule {
  return {
    storesResultsExternally(): boolean {
      return false;
    },

    async register(_job: JobRecord): Promise<void> {},

    async owner(id: string, kind: JobKind): Promise<JobOwner | null> {
      if (kind === "scrape") {
        const [
          { scrapeQueue },
          { normalizeOwnerId },
          { safeParseLogged, singleUrlModeSchema, singleUrlJobDataSchema },
        ] = await Promise.all([
          import("../services/worker/nuq-router.js"),
          import("../lib/owner-id.js"),
          getQueueJobStoreSchemas(),
        ]);
        const job = await scrapeQueue.getJob(id);
        if (!job) {
          return null;
        }
        const jobData: unknown = job.data;
        let rawTeamId: string | undefined;
        if (jobData !== null && jobData !== undefined) {
          if (!singleUrlModeSchema.safeParse(jobData).success) {
            return null;
          }
          const parsedData = safeParseLogged(
            singleUrlJobDataSchema,
            jobData,
            "queue-job-store.singleUrlJobData",
          );
          if (!parsedData.success) {
            return null;
          }
          rawTeamId = parsedData.data.team_id;
        }
        const teamId = rawTeamId ?? job.ownerId;
        if (!teamId) {
          return null;
        }
        return {
          teamId,
          matchesTeam(candidate: string): boolean {
            if (rawTeamId !== undefined) {
              return rawTeamId === candidate;
            }
            return job.ownerId === normalizeOwnerId(candidate);
          },
        };
      }

      const { getCrawl } = await import("../lib/crawl-redis.js");
      const crawl = await getCrawl(id);
      if (!crawl?.team_id) {
        return null;
      }
      return { teamId: crawl.team_id };
    },

    async read(id: string, kind: JobKind): Promise<StoredJob | null> {
      if (kind !== "scrape") {
        return null;
      }
      const [{ scrapeQueue }, { singleUrlModeSchema, storedDocumentSchema }] =
        await Promise.all([
          import("../services/worker/nuq-router.js"),
          getQueueJobStoreSchemas(),
        ]);
      const job = await scrapeQueue.getJob(id);
      if (!job) {
        return null;
      }
      const jobData: unknown = job.data;
      if (
        jobData !== null &&
        jobData !== undefined &&
        !singleUrlModeSchema.safeParse(jobData).success
      ) {
        return null;
      }
      const completedAtMs =
        job.finishedAt !== undefined ? job.finishedAt.valueOf() : undefined;
      if (job.status === "completed") {
        const raw: unknown = job.returnvalue;
        const doc: unknown = Array.isArray(raw) ? raw[0] : raw;
        const stored: StoredJob = { state: "completed" };
        if (doc !== null && doc !== undefined) {
          const parsedDoc = storedDocumentSchema.safeParse(doc);
          if (parsedDoc.success) {
            stored.document = parsedDoc.data;
          }
        }
        if (completedAtMs !== undefined) {
          stored.completedAtMs = completedAtMs;
        }
        return stored;
      }
      if (job.status === "failed") {
        const stored: StoredJob = { state: "failed" };
        if (job.failedReason) {
          stored.error = job.failedReason;
        }
        if (completedAtMs !== undefined) {
          stored.completedAtMs = completedAtMs;
        }
        return stored;
      }
      return null;
    },

    async record(_job: JobRecord, _outcome: JobOutcome): Promise<void> {},

    async usage(
      _requestId: string,
      _options?: JobUsageOptions,
    ): Promise<number | null> {
      return null;
    },

    async remove(_id: string, _kind: JobKind): Promise<void> {},
  };
}

const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_IDEMPOTENCY_TIMEOUT_MS = 5000;

let idempotencyRedisPromise: Promise<Redis> | undefined;

function getIdempotencyRedis(): Promise<Redis> {
  if (!idempotencyRedisPromise) {
    idempotencyRedisPromise = (async () => {
      const [{ Redis }, { config }, { logger }] = await Promise.all([
        import("ioredis"),
        import("../config.js"),
        import("../lib/logger.js"),
      ]);
      if (!config.REDIS_URL) {
        throw new Error("REDIS_URL is not configured");
      }
      const client = new Redis(config.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        commandTimeout: DEFAULT_IDEMPOTENCY_TIMEOUT_MS,
      });
      client.on("error", error => {
        logger.warn("Idempotency Redis error", { error });
      });
      return client;
    })().catch((error: unknown) => {
      idempotencyRedisPromise = undefined;
      throw error;
    });
  }
  return idempotencyRedisPromise;
}

export interface RedisIdempotencyOptions {
  /** Expiration in seconds for claimed keys. Defaults to 86400 (24 hours). */
  ttlSeconds?: number;
  /** Custom atomic set-if-absent backend; defaults to a fail-fast main Redis client. */
  setIfAbsent?: (key: string, ttlSeconds: number) => Promise<boolean>;
}

/**
 * Redis-backed idempotency module using atomic SET NX EX scoped by teamId.
 * Loads the Redis client lazily on first claim so constructing defaults has
 * no import-time side effects.
 */
export function redisIdempotency(
  options: RedisIdempotencyOptions = {},
): IdempotencyModule {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("Invalid idempotency ttlSeconds");
  }
  if (
    options.setIfAbsent !== undefined &&
    typeof options.setIfAbsent !== "function"
  ) {
    throw new Error("Invalid idempotency setIfAbsent");
  }

  const setIfAbsent =
    options.setIfAbsent ??
    (async (key: string, ttl: number): Promise<boolean> => {
      const client = await getIdempotencyRedis();
      const result = await client.set(key, "1", "EX", ttl, "NX");
      return result === "OK";
    });

  return {
    claim(key, ctx) {
      return setIfAbsent(`idempotency:${ctx.teamId}:${key}`, ttlSeconds);
    },
  };
}

export interface DirectWebhooksOptions {
  /**
   * Static secret or lazy secret resolver. When omitted, reads
   * `SELF_HOSTED_WEBHOOK_HMAC_SECRET` from config at call time.
   */
  secret?: string | (() => string | undefined);
}

/**
 * In-process webhook module that reads `SELF_HOSTED_WEBHOOK_HMAC_SECRET`
 * lazily at call time and sends webhook deliveries directly over HTTP.
 */
export function directWebhooks(
  options: DirectWebhooksOptions = {},
): WebhooksModule {
  if (
    options.secret !== undefined &&
    typeof options.secret !== "string" &&
    typeof options.secret !== "function"
  ) {
    throw new Error("Invalid webhooks secret");
  }
  const hasExplicitSecret = Object.hasOwn(options, "secret");
  const explicitSecret =
    typeof options.secret === "string" ? options.secret : undefined;
  const resolveSecret: () => Promise<string | undefined> | string | undefined =
    typeof options.secret === "function"
      ? options.secret
      : hasExplicitSecret
        ? () => explicitSecret
        : async () =>
            (await import("../config.js")).config
              .SELF_HOSTED_WEBHOOK_HMAC_SECRET;

  return {
    async signingSecret() {
      return resolveSecret();
    },
    async deliver(_ctx, _delivery, send) {
      const res = await send();
      return { delivered: res.ok, queued: false, statusCode: res.status };
    },
  };
}

/**
 * Default policy module: admits every request with no restrictions, preserves
 * caller-requested `zeroDataRetention`, and propagates `zeroDataRetention` and
 * `usOnly` to system sub-requests. Typed on `BaseRequestContext` so widening
 * `RequestContext` rejects it at compile time.
 */
export function unrestrictedPolicy(): PolicyModule<BaseRequestContext> {
  return {
    async admit({ kind, caller, body }) {
      const enterprise =
        "enterprise" in body && Array.isArray(body.enterprise)
          ? body.enterprise
          : [];
      const bodyZdr =
        "zeroDataRetention" in body && body.zeroDataRetention === true;
      const bodyLockdown = "lockdown" in body && body.lockdown === true;
      const zeroDataRetention =
        bodyZdr ||
        bodyLockdown ||
        (kind === "search" &&
          (enterprise.includes("zdr") || enterprise.includes("anon")));
      const ignoreRobotsTxt =
        "ignoreRobotsTxt" in body && typeof body.ignoreRobotsTxt === "boolean"
          ? body.ignoreRobotsTxt
          : undefined;
      const robotsUserAgent =
        "robotsUserAgent" in body && typeof body.robotsUserAgent === "string"
          ? body.robotsUserAgent
          : undefined;
      const ctx: BaseRequestContext = {
        teamId: caller.teamId,
        zeroDataRetention,
      };
      if (ignoreRobotsTxt !== undefined) {
        ctx.ignoreRobotsTxt = ignoreRobotsTxt;
      }
      if (robotsUserAgent !== undefined) {
        ctx.robotsUserAgent = robotsUserAgent;
      }
      if (bodyLockdown) {
        ctx.lockdown = true;
      }
      return {
        ok: true,
        ctx,
        body,
      };
    },
    system(purpose, parent) {
      const ctx: BaseRequestContext = {
        teamId: purpose,
        zeroDataRetention: parent?.zeroDataRetention ?? false,
      };
      if (parent?.usOnly) {
        ctx.usOnly = true;
      }
      return ctx;
    },
    async context({ caller }) {
      return {
        ok: true,
        ctx: {
          teamId: caller.teamId,
          zeroDataRetention: false,
        },
      };
    },
  };
}

/**
 * The default slot table, with `auth` typed on `BaseCaller` and `policy` typed
 * on `BaseRequestContext`. Assignable to `Modules` only when neither `Caller`
 * nor `RequestContext` has been widened with required fields.
 */
export type DefaultModules = Omit<Modules, "auth" | "policy"> & {
  auth: AuthModule<BaseCaller>;
  policy: PolicyModule<BaseRequestContext>;
};

/** Returns fresh instances of every default module slot. */
export function defaultModules(): DefaultModules {
  return {
    auth: openAuth(),
    billing: unmeteredBilling(),
    blocklist: noBlocklist(),
    limits: noLimits(),
    messages: logsMessages(),
    policy: unrestrictedPolicy(),
    uploads: memoryUploads(),
    jobStore: queueJobStore(),
    idempotency: redisIdempotency(),
    webhooks: directWebhooks(),
  };
}
