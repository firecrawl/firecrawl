import crypto from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { ApiError } from "@google-cloud/storage";
import {
  type RateLimiterAbstract,
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
} from "rate-limiter-flexible";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import IORedis from "ioredis";
import { z } from "zod";
import { config } from "../../config";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import { storage } from "../../lib/gcs-jobs";
import { logger as _logger } from "../../lib/logger";
import { getEffectiveSearchForcedKind } from "../../lib/safe-mode";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { redisRateLimitClient } from "../../services/rate-limiter";
import type { RequestWithAuth } from "./types";

// The limit for a whole session workspace and for any one file behind a link.
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const LINK_DEFAULT_SECONDS = 15 * 60;
const LINK_MAX_SECONDS = 60 * 60;
const MEBIBYTE = 1024 * 1024;
// Each link counts in whole mebibytes, so this is also the most links a team
// can make in an hour.
const LINK_MEBIBYTES_PER_HOUR = 2048;
// A session ends this long after its last save. The bucket deletes a
// workspace a day after its last save, so it cannot be longer than that.
const SESSION_IDLE = sql`interval '1 day'`;
const SESSION_MAX = sql`interval '7 days'`;
export const MAX_LIVE_SESSIONS = 100;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 16 random bytes in base64url.
const LINK_TOKEN = /^[A-Za-z0-9_-]{22}$/;
const LINK_KEY = "computer-session-link:";

const logger = _logger.child({ module: "computer-session-files" });

export type ComputerSessionFileStore = {
  write(objectPath: string, body: Readable): Promise<void>;
  /** The object's bytes, or null when it is not stored. */
  read(objectPath: string): Promise<Readable | null>;
  delete(objectPath: string): Promise<void>;
  downloadUrl(
    objectPath: string,
    filename: string,
    expiresAt: number,
  ): Promise<string>;
};

/** The signed URL each short link redirects to, kept until the link ends. */
export type LinkTargets = {
  set(token: string, url: string, expiresAt: number): Promise<unknown>;
  get(token: string): Promise<string | null>;
};

export function gcsStore(bucketName: string): ComputerSessionFileStore {
  const bucket = storage.bucket(bucketName);
  return {
    async write(objectPath, body) {
      await pipeline(
        body,
        bucket.file(objectPath).createWriteStream({
          resumable: false,
          contentType: "application/octet-stream",
        }),
      );
    },
    async read(objectPath) {
      const body = bucket.file(objectPath).createReadStream();
      try {
        // Waits for the first bytes, so a failure is still an error response.
        await once(body, "readable");
      } catch (error) {
        if (error instanceof ApiError && error.code === 404) return null;
        throw error;
      }
      return body;
    },
    async delete(objectPath) {
      await bucket.file(objectPath).delete({ ignoreNotFound: true });
    },
    async downloadUrl(objectPath, filename, expiresAt) {
      const [url] = await bucket.file(objectPath).getSignedUrl({
        version: "v4",
        action: "read",
        expires: expiresAt,
        // Signed with the URL, so a browser only ever saves the file.
        responseDisposition: `attachment; filename="${filename}"`,
        responseType: "application/octet-stream",
      });
      return url;
    },
  };
}

type SessionRequest = RequestWithAuth<{ sessionId: string }, any, any>;

const refuse = (res: Response, status: number, error: string) => {
  res.status(status).json({ success: false, error });
};

const sessions = schema.computer_sessions;
const iso = (timestamp: string | number) => new Date(timestamp).toISOString();
const NO_SESSION = "Session not found or expired. Create a new session.";
// Not now(): inside insertSession that is the time before the wait for the
// team's lock, when sessions another creation ended since still look live.
const live = gt(sessions.expires_at, sql`clock_timestamp()`);
const workspacePath = (teamId: string, sessionId: string) =>
  `workspaces/${teamId}/${sessionId}`;

/**
 * Records a new session. A team at the limit of live sessions gives up the
 * ones saved longest ago; the lock keeps concurrent creations from passing
 * the limit together.
 */
async function insertSession(teamId: string, id: string) {
  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`computer_sessions:${teamId}`}, 0))`,
    );
    const ended = await tx
      .update(sessions)
      .set({ expires_at: sql`clock_timestamp()` })
      .where(
        inArray(
          sessions.id,
          tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(eq(sessions.team_id, teamId), live))
            .orderBy(
              desc(
                sql`COALESCE(${sessions.last_saved_at}, ${sessions.created_at})`,
              ),
            )
            .offset(MAX_LIVE_SESSIONS - 1),
        ),
      )
      .returning({ id: sessions.id });
    const [created] = await tx
      .insert(sessions)
      .values({
        id,
        team_id: teamId,
        expires_at: sql`clock_timestamp() + ${SESSION_IDLE}`,
      })
      .returning({ expires_at: sessions.expires_at });
    return {
      expiresAt: created.expires_at,
      ended: ended.map(session => session.id),
    };
  });
}

/** The caller's team, or null once a refusal has been sent. */
function hostedMcpTeam(
  req: RequestWithAuth<any, any, any>,
  res: Response,
): string | null {
  if (!req.auth.hostedMcp) {
    refuse(
      res,
      403,
      "This endpoint is only available through the hosted Firecrawl MCP server.",
    );
    return null;
  }
  const flags = req.acuc?.flags;
  if (
    getScrapeZDR(flags) === "forced" ||
    getEffectiveSearchForcedKind(flags, undefined) !== null
  ) {
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
  // The HTTP parser holds the body to the length it declares.
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
 * socket, so the caller still gets the error response.
 */
function bodyOf(req: Request, res: Response): Readable {
  const body = new PassThrough();
  req.pipe(body);
  const closed = () => {
    if (!req.complete) {
      body.destroy(new Error("The request ended before its body did."));
    }
  };
  if (req.closed) closed();
  else req.once("close", closed);
  // A failed write can leave part of the body unread, so the connection is
  // not reused after it.
  body.once("error", () => {
    if (!res.headersSent) res.setHeader("Connection", "close");
  });
  return body;
}

// The hosted MCP may reach the API on an internal address.
const publicBaseUrl = (req: Request) =>
  config.COMPUTER_SESSION_FILES_PUBLIC_BASE_URL?.replace(/\/$/, "") ??
  `${req.protocol}://${req.host}`;

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
  /** Counts the mebibytes of each team's links. */
  linkLimit: RateLimiterAbstract,
  linkTargets: LinkTargets,
) {
  /**
   * The team's live session the request names, or null once a refusal has been
   * sent. An unknown id, another team's id and an expired session all answer
   * the same.
   */
  async function liveSession(
    req: SessionRequest,
    res: Response,
    teamId: string,
  ) {
    const id = req.params.sessionId;
    const [session] = SESSION_ID.test(id)
      ? await db
          .select({ last_saved_at: sessions.last_saved_at })
          .from(sessions)
          .where(and(eq(sessions.id, id), eq(sessions.team_id, teamId), live))
          .limit(1)
      : [];
    if (!session) {
      refuse(res, 404, NO_SESSION);
      return null;
    }
    return {
      id,
      objectPath: workspacePath(teamId, id),
      saved: session.last_saved_at !== null,
    };
  }

  /** A failure leaves an ended session's workspace to the bucket's lifecycle. */
  async function discardWorkspace(teamId: string, sessionId: string) {
    try {
      await store.delete(workspacePath(teamId, sessionId));
    } catch (error) {
      logger.warn("Computer session workspace not deleted", {
        teamId,
        sessionId,
        error,
      });
    }
  }

  return {
    async createSession(req: RequestWithAuth<{}, any, any>, res: Response) {
      const teamId = hostedMcpTeam(req, res);
      if (teamId === null) return;
      const id = crypto.randomUUID();
      const { expiresAt, ended } = await insertSession(teamId, id);
      await Promise.all(
        ended.map(sessionId => discardWorkspace(teamId, sessionId)),
      );
      logger.info("Computer session created", {
        teamId,
        sessionId: id,
        ended: ended.length,
      });
      res.status(200).json({
        success: true,
        data: { id, expiresAt: iso(expiresAt) },
      });
    },

    /** Replaces the session's workspace and moves the session's end out. */
    async saveWorkspace(req: SessionRequest, res: Response) {
      const teamId = hostedMcpTeam(req, res);
      if (teamId === null) return;
      const sizeBytes = declaredSize(req, res);
      if (sizeBytes === null) return;
      const session = await liveSession(req, res, teamId);
      if (!session) return;

      await store.write(session.objectPath, bodyOf(req, res));
      // A session that ended during the upload stays ended.
      const [extended] = await db
        .update(sessions)
        .set({
          last_saved_at: sql`clock_timestamp()`,
          expires_at: sql`LEAST(clock_timestamp() + ${SESSION_IDLE}, ${sessions.created_at} + ${SESSION_MAX})`,
        })
        .where(and(eq(sessions.id, session.id), live))
        .returning({ expires_at: sessions.expires_at });
      if (!extended) {
        await discardWorkspace(teamId, session.id);
        return refuse(res, 404, NO_SESSION);
      }
      res.status(200).json({
        success: true,
        data: { sizeBytes, expiresAt: iso(extended.expires_at) },
      });
    },

    async readWorkspace(req: SessionRequest, res: Response) {
      const teamId = hostedMcpTeam(req, res);
      if (teamId === null) return;
      const session = await liveSession(req, res, teamId);
      if (!session) return;
      const body = await store.read(session.objectPath);
      if (!body && session.saved) {
        return refuse(
          res,
          410,
          "This session's files are no longer stored. Create a new session.",
        );
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "private, no-store");
      try {
        // A session that was never saved reads as empty.
        await pipeline(body ?? Readable.from([]), res);
      } catch (error) {
        logger.warn("Computer session file stream ended early", { error });
      }
    },

    /**
     * Stores the file in the body and returns a short link to it. A signed
     * URL is about a thousand characters, which is a lot for an agent to copy.
     */
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
      const mebibytes = Math.ceil(sizeBytes / MEBIBYTE);
      try {
        await linkLimit.consume(teamId, mebibytes);
      } catch (rejection) {
        if (!(rejection instanceof RateLimiterRes)) throw rejection;
        const seconds = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000));
        res.setHeader("Retry-After", String(seconds));
        return refuse(
          res,
          429,
          `This team has reached its hourly limit for download links. Try again in ${seconds} seconds.`,
        );
      }

      const filename =
        path
          .basename(query.data.filename)
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .replace(/^\.+/, "") || "download";
      const linkId = crypto.randomUUID();
      const objectPath = `links/${linkId}/${filename}`;
      // The token alone opens the link, so it is not logged.
      const token = crypto.randomBytes(16).toString("base64url");
      let expiresAt: number;
      try {
        await store.write(objectPath, bodyOf(req, res));
        // Counted from the end of the upload.
        expiresAt = Date.now() + query.data.expiresInSeconds * 1000;
        await linkTargets.set(
          token,
          await store.downloadUrl(objectPath, filename, expiresAt),
          expiresAt,
        );
      } catch (error) {
        await Promise.allSettled([
          linkLimit.reward(teamId, mebibytes),
          store.delete(objectPath),
        ]);
        throw error;
      }
      logger.info("Computer session link created", {
        teamId,
        sessionId: req.params.sessionId,
        linkId,
        sizeBytes,
        expiresInSeconds: query.data.expiresInSeconds,
      });
      res.status(200).json({
        success: true,
        data: {
          url: `${publicBaseUrl(req)}/v2/computer/links/${token}`,
          expiresAt: iso(expiresAt),
          sizeBytes,
        },
      });
    },

    /** Redirects a short link to the signed URL it stands for. */
    async openLink(req: Request<{ token: string }>, res: Response) {
      const url = LINK_TOKEN.test(req.params.token)
        ? await linkTargets.get(req.params.token)
        : null;
      if (!url) return refuse(res, 404, "Download link not found or expired.");
      res.redirect(302, url);
    },
  };
}

/** The session file handlers, or null on a deployment with no bucket for them. */
export function configuredComputerSessionFiles() {
  const bucket = config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME;
  if (!bucket) return null;
  const hour = { points: LINK_MEBIBYTES_PER_HOUR, duration: 60 * 60 };
  const memory = new RateLimiterMemory(hour);
  // Its own connection: the queue's never fails a command while Redis is
  // away, and the rate limit Redis may evict a key before its link ends.
  const redis = new IORedis(config.REDIS_URL!, { lazyConnect: true });
  return computerSessionFileControllers(
    gcsStore(bucket),
    // Counted across every replica, or in this process without Redis.
    config.REDIS_RATE_LIMIT_URL
      ? new RateLimiterRedis({
          ...hour,
          storeClient: redisRateLimitClient,
          keyPrefix: "computer-session-link-mebibytes",
          insuranceLimiter: memory,
        })
      : memory,
    {
      set: (token, url, expiresAt) =>
        redis.set(LINK_KEY + token, url, "PX", expiresAt - Date.now()),
      get: token => redis.get(LINK_KEY + token),
    },
  );
}
