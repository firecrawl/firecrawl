import crypto from "node:crypto";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, RequestHandler, Response } from "express";
import { ApiError, Storage } from "@google-cloud/storage";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
} from "rate-limiter-flexible";
import { z } from "zod";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { getRedisConnection } from "../../services/queue-service";
import { redisRateLimitClient } from "../../services/rate-limiter";
import type { RequestWithAuth } from "./types";

// The limit for a whole session workspace and for any one file behind a link.
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const LINK_DEFAULT_SECONDS = 15 * 60;
const LINK_MAX_SECONDS = 60 * 60;
const DOWNLOADS_PER_MINUTE = 60;
// A session ends a day after it is created, however much it is used, so it
// never becomes long-term storage.
const SESSION_SECONDS = 24 * 60 * 60;
export const MAX_LIVE_SESSIONS = 100;
// The UUID a new session is given.
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 32 random bytes in base64url.
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const logger = _logger.child({ module: "computer-session-files" });

type StoredFile = {
  sizeBytes: number;
  version: string;
  metadata: Record<string, string>;
  stream(): Readable;
};

export type ComputerSessionFileStore = {
  /**
   * Replaces the object and returns its new version. With `ifVersion`, throws
   * VersionMismatchError unless that is the stored version; "0" means nothing
   * is stored yet.
   */
  write(
    objectPath: string,
    body: Readable,
    options?: { metadata?: Record<string, string>; ifVersion?: string },
  ): Promise<string>;
  read(objectPath: string): Promise<StoredFile | null>;
};

export class VersionMismatchError extends Error {}

const stringValues = (metadata: object | undefined) =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [key, String(value)]),
  );

function gcsStore(bucketName: string): ComputerSessionFileStore {
  const bucket = new Storage({
    credentials: config.GCS_CREDENTIALS
      ? JSON.parse(atob(config.GCS_CREDENTIALS))
      : undefined,
  }).bucket(bucketName);
  return {
    async write(objectPath, body, { metadata, ifVersion } = {}) {
      const file = bucket.file(objectPath);
      try {
        await pipeline(
          body,
          file.createWriteStream({
            resumable: false,
            contentType: "application/octet-stream",
            metadata: { metadata },
            ...(ifVersion === undefined
              ? {}
              : { preconditionOpts: { ifGenerationMatch: ifVersion } }),
          }),
        );
      } catch (error) {
        if (error instanceof ApiError && error.code === 412) {
          throw new VersionMismatchError();
        }
        throw error;
      }
      // The upload's own response, so the version is the one this call wrote
      // even when another save lands right after it.
      const { generation } = file.metadata;
      if (generation === undefined) {
        throw new Error("The upload response did not name a generation.");
      }
      return String(generation);
    },
    async read(objectPath) {
      let stored;
      try {
        [stored] = await bucket.file(objectPath).getMetadata();
      } catch (error) {
        if (error instanceof ApiError && error.code === 404) return null;
        throw error;
      }
      const generation = String(stored.generation);
      return {
        sizeBytes: Number(stored.size),
        version: generation,
        metadata: stringValues(stored.metadata),
        // Pinned to the version just read, so the bytes match the size sent.
        stream: () =>
          bucket.file(objectPath, { generation }).createReadStream(),
      };
    },
  };
}

type SessionRequest = RequestWithAuth<{ sessionId: string }, any, any>;

const refuse = (res: Response, status: number, error: string) => {
  res.status(status).json({ success: false, error });
};

const liveSessionsKey = (teamId: string) => `computer-sessions:${teamId}`;

/**
 * Counts a new session against the team's live ones in one atomic step, so
 * concurrent creations cannot pass the limit together. False at the limit.
 */
async function reserveSession(
  teamId: string,
  sessionId: string,
  expiresAt: number,
): Promise<boolean> {
  const reserved = await getRedisConnection().eval(
    `
      redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
      if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[2]) then
        return 0
      end
      redis.call("ZADD", KEYS[1], ARGV[4], ARGV[3])
      redis.call("PEXPIREAT", KEYS[1], ARGV[4])
      return 1
    `,
    1,
    liveSessionsKey(teamId),
    Date.now(),
    MAX_LIVE_SESSIONS,
    sessionId,
    expiresAt,
  );
  return Number(reserved) === 1;
}

/** Written so that a session or link with no expiry recorded is never live. */
const isLive = (metadata: Record<string, string>) =>
  Date.now() < Number(metadata.expiresAt);

/** The caller's team, or null once a refusal has been sent. */
function hostedMcpTeam(
  req: RequestWithAuth<any, any, any>,
  res: Response,
): string | null {
  // A session holds what a hosted MCP shell wrote, so only the hosted MCP
  // creates and uses one. A plain API key cannot use this as file hosting.
  if (!req.auth.hostedMcp) {
    refuse(
      res,
      403,
      "This endpoint is only available through the hosted Firecrawl MCP server.",
    );
    return null;
  }
  if (getScrapeZDR(req.acuc?.flags) === "forced") {
    refuse(
      res,
      403,
      "Session files are not available with zero data retention.",
    );
    return null;
  }
  return req.auth.team_id;
}

/** The declared size of the file in the body, or null once a refusal has been sent. */
function declaredSize(req: Request, res: Response): number | null {
  if (!req.is("application/octet-stream")) {
    refuse(res, 415, "Send the file as an application/octet-stream body.");
    return null;
  }
  // The size is checked before any byte is read, and the HTTP parser holds the
  // body to the length it declares.
  const size = Number(req.get("content-length"));
  if (!Number.isInteger(size) || size < 1) {
    refuse(res, 411, "Send the file with a Content-Length.");
    return null;
  }
  if (size > MAX_FILE_BYTES) {
    refuse(res, 413, `The file is larger than ${MAX_FILE_BYTES} bytes.`);
    return null;
  }
  return size;
}

/**
 * The request body as a stream the store can fail on without closing the
 * socket, so the caller still hears why.
 */
function bodyOf(req: Request, res: Response): Readable {
  const body = new PassThrough();
  req.pipe(body);
  const closed = () => {
    if (!req.complete) {
      body.destroy(new Error("The request ended before its body did."));
    }
  };
  // The caller may have gone while the session was being looked up.
  if (req.closed) closed();
  else req.once("close", closed);
  // A failed write can leave part of the body unread, so the connection is
  // not reused after it.
  body.once("error", () => {
    if (!res.headersSent) res.setHeader("Connection", "close");
  });
  return body;
}

async function send(res: Response, file: StoredFile) {
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(file.sizeBytes));
  res.setHeader("Cache-Control", "private, no-store");
  try {
    await pipeline(file.stream(), res);
  } catch (error) {
    // The headers are out, so there is no error response left to send.
    logger.warn("Computer session file stream ended early", { error });
  }
}

// A session is one object: its workspace, empty until the first save, with
// the session's expiry in its metadata.
const teamPrefix = (teamId: string) =>
  `workspaces/${encodeURIComponent(teamId)}/`;

const linkSchema = z.object({
  filename: z.string().min(1).max(255),
  expiresInSeconds: z.coerce
    .number()
    .int()
    .min(60)
    .max(LINK_MAX_SECONDS)
    .default(LINK_DEFAULT_SECONDS),
});

export function computerSessionFileControllers(
  store: ComputerSessionFileStore,
  publicBaseUrl: string,
) {
  /**
   * The team's live session the request names, or null once a refusal has been
   * sent. An id the API did not issue, another team's id and an expired
   * session all answer the same.
   */
  async function liveSession(
    req: SessionRequest,
    res: Response,
    teamId: string,
  ) {
    const objectPath = teamPrefix(teamId) + req.params.sessionId;
    const workspace = SESSION_ID.test(req.params.sessionId)
      ? await store.read(objectPath)
      : null;
    if (!workspace || !isLive(workspace.metadata)) {
      refuse(res, 404, "Session not found or expired. Create a new session.");
      return null;
    }
    return { objectPath, workspace };
  }

  return {
    /** Starts a session: an id only this team can use, and an empty workspace. */
    async createSession(req: RequestWithAuth<{}, any, any>, res: Response) {
      const teamId = hostedMcpTeam(req, res);
      if (teamId === null) return;
      const id = crypto.randomUUID();
      const expiresAt = Date.now() + SESSION_SECONDS * 1000;
      if (!(await reserveSession(teamId, id, expiresAt))) {
        return refuse(
          res,
          429,
          `This team already has ${MAX_LIVE_SESSIONS} live sessions. Wait for one to expire.`,
        );
      }
      try {
        await store.write(teamPrefix(teamId) + id, Readable.from([]), {
          metadata: { expiresAt: String(expiresAt) },
          ifVersion: "0",
        });
      } catch (error) {
        // A session that was never stored gives its place back. One that
        // cannot be given back frees itself when it would have expired.
        await getRedisConnection()
          .zrem(liveSessionsKey(teamId), id)
          .catch(release =>
            logger.warn("Failed to release a computer session slot", {
              error: release,
            }),
          );
        throw error;
      }
      logger.info("Computer session created", { teamId, sessionId: id });
      res.status(200).json({
        success: true,
        data: { id, expiresAt: new Date(expiresAt).toISOString() },
      });
    },

    /** Stores the session's workspace, replacing the one saved before. */
    async saveWorkspace(req: SessionRequest, res: Response) {
      const teamId = hostedMcpTeam(req, res);
      if (teamId === null) return;
      const sizeBytes = declaredSize(req, res);
      if (sizeBytes === null) return;
      // The version a read returned, so two shells saving the same session
      // cannot silently overwrite each other.
      const ifVersion = req.get("if-match")?.replace(/"/g, "");
      if (ifVersion !== undefined && !/^\d+$/.test(ifVersion)) {
        return refuse(res, 400, "If-Match takes the version a read returned.");
      }

      const session = await liveSession(req, res, teamId);
      if (!session) return;

      let version: string;
      try {
        // The save keeps the expiry the session was created with.
        version = await store.write(session.objectPath, bodyOf(req, res), {
          metadata: session.workspace.metadata,
          ifVersion,
        });
      } catch (error) {
        if (!(error instanceof VersionMismatchError)) throw error;
        return refuse(
          res,
          412,
          "The workspace changed since it was read. Read it again.",
        );
      }
      res.setHeader("ETag", `"${version}"`);
      res.status(200).json({ success: true, data: { sizeBytes, version } });
    },

    async readWorkspace(req: SessionRequest, res: Response) {
      const teamId = hostedMcpTeam(req, res);
      if (teamId === null) return;
      const session = await liveSession(req, res, teamId);
      if (!session) return;
      res.setHeader("ETag", `"${session.workspace.version}"`);
      await send(res, session.workspace);
    },

    /** Stores the file in the body and returns a link anyone can download it from until it expires. */
    async createLink(req: SessionRequest, res: Response) {
      const teamId = hostedMcpTeam(req, res);
      if (teamId === null) return;
      const query = linkSchema.safeParse(req.query);
      if (!query.success) {
        return refuse(
          res,
          400,
          query.error.issues[0]?.message ?? "Invalid link request.",
        );
      }
      const sizeBytes = declaredSize(req, res);
      if (sizeBytes === null) return;
      if (!(await liveSession(req, res, teamId))) return;

      const filename =
        path
          .basename(query.data.filename)
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .replace(/^\.+/, "") || "download";
      // The token is the only way to the file: it names the stored object and
      // is never logged.
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + query.data.expiresInSeconds * 1000;
      await store.write(`links/${token}`, bodyOf(req, res), {
        metadata: {
          teamId,
          sessionId: req.params.sessionId,
          filename,
          expiresAt: String(expiresAt),
        },
      });
      logger.info("Computer session link created", {
        teamId,
        sessionId: req.params.sessionId,
        sizeBytes,
        expiresInSeconds: query.data.expiresInSeconds,
      });
      res.status(200).json({
        success: true,
        data: {
          url: `${publicBaseUrl.replace(/\/$/, "")}/v2/computer/files/${token}/${filename}`,
          expiresAt: new Date(expiresAt).toISOString(),
          sizeBytes,
        },
      });
    },

    /** Serves a link's file to whoever holds the link. */
    async download(req: Request<{ token: string }>, res: Response) {
      const file = LINK_TOKEN.test(req.params.token)
        ? await store.read(`links/${req.params.token}`)
        : null;
      if (!file) return refuse(res, 404, "Download link not found.");
      if (!isLive(file.metadata)) {
        return refuse(res, 410, "This download link has expired.");
      }
      logger.info("Computer session link downloaded", {
        teamId: file.metadata.teamId,
        sessionId: file.metadata.sessionId,
        sizeBytes: file.sizeBytes,
      });
      // The file is whatever a shell produced, so a browser only ever saves it.
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${file.metadata.filename}"`,
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
      await send(res, file);
    },
  };
}

/** Downloads per IP per minute across every replica; the download route has no other caller identity. */
function downloadRateLimit(): RequestHandler {
  const memory = new RateLimiterMemory({
    points: DOWNLOADS_PER_MINUTE,
    duration: 60,
  });
  const limiter = config.REDIS_RATE_LIMIT_URL
    ? new RateLimiterRedis({
        storeClient: redisRateLimitClient,
        keyPrefix: "computer-session-download",
        points: DOWNLOADS_PER_MINUTE,
        duration: 60,
        insuranceLimiter: memory,
      })
    : memory;
  return async (req, res, next) => {
    try {
      await limiter.consume(req.ip ?? "unknown");
      next();
    } catch (rejection) {
      if (!(rejection instanceof RateLimiterRes)) return next(rejection);
      const seconds = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000));
      res.setHeader("Retry-After", String(seconds));
      refuse(res, 429, `Too many downloads. Try again in ${seconds} seconds.`);
    }
  };
}

/**
 * The session file handlers, or null on a deployment that does not name both
 * the bucket and the public address its links use.
 */
export function configuredComputerSessionFiles() {
  const bucket = config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME;
  const publicBaseUrl = config.COMPUTER_SESSION_FILES_PUBLIC_BASE_URL;
  if (!bucket || !publicBaseUrl) {
    if (bucket || publicBaseUrl) {
      logger.warn(
        "Session files need both GCS_COMPUTER_SESSION_FILES_BUCKET_NAME and COMPUTER_SESSION_FILES_PUBLIC_BASE_URL; the routes are disabled.",
      );
    }
    return null;
  }
  return {
    ...computerSessionFileControllers(gcsStore(bucket), publicBaseUrl),
    downloadRateLimit: downloadRateLimit(),
  };
}
