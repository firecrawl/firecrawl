import crypto from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { ApiError, Storage } from "@google-cloud/storage";
import {
  type RateLimiterAbstract,
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
} from "rate-limiter-flexible";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { config } from "../../config";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";
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
// What a team's links may hold in an hour. Each link counts in whole
// mebibytes, so this is also the most links a team can make in an hour.
const LINK_MEBIBYTES_PER_HOUR = 2048;
// How often a read looks a workspace up again when a save replaced it first.
const READ_ATTEMPTS = 3;
// A session ends a day after its workspace was last saved, and a week after it
// was created however often it is saved, so it never becomes long-term
// storage. The bucket deletes a workspace a day after its last save, so the
// idle time cannot be longer than that.
const SESSION_IDLE_SECONDS = 24 * 60 * 60;
const SESSION_MAX_SECONDS = 7 * 24 * 60 * 60;
export const MAX_LIVE_SESSIONS = 100;
// The UUID a new session is given.
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const logger = _logger.child({ module: "computer-session-files" });

type StoredFile = {
  sizeBytes: number;
  version: string;
  /**
   * This version's bytes, once the first of them is there to send. Throws
   * VersionReplacedError when the version is no longer stored.
   */
  open(): Promise<Readable>;
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
    options?: { ifVersion?: string },
  ): Promise<string>;
  read(objectPath: string): Promise<StoredFile | null>;
  /** Removes the object, if it is stored. */
  delete(objectPath: string): Promise<void>;
  /**
   * A URL that downloads the object as `filename`, for anyone who holds it,
   * until `expiresAt`.
   */
  downloadUrl(
    objectPath: string,
    filename: string,
    expiresAt: number,
  ): Promise<string>;
};

export class VersionMismatchError extends Error {}
export class VersionReplacedError extends Error {}

export function gcsStore(bucketName: string): ComputerSessionFileStore {
  const bucket = new Storage({
    credentials: config.GCS_CREDENTIALS
      ? JSON.parse(atob(config.GCS_CREDENTIALS))
      : undefined,
  }).bucket(bucketName);
  return {
    async write(objectPath, body, { ifVersion } = {}) {
      const file = bucket.file(objectPath);
      try {
        await pipeline(
          body,
          file.createWriteStream({
            resumable: false,
            contentType: "application/octet-stream",
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
        async open() {
          // Pinned to the version just read, so the bytes match the size sent.
          const body = bucket
            .file(objectPath, { generation })
            .createReadStream();
          try {
            await once(body, "readable");
          } catch (error) {
            if (error instanceof ApiError && error.code === 404) {
              throw new VersionReplacedError();
            }
            throw error;
          }
          return body;
        },
      };
    },
    async delete(objectPath) {
      await bucket.file(objectPath).delete({ ignoreNotFound: true });
    },
    async downloadUrl(objectPath, filename, expiresAt) {
      const [url] = await bucket.file(objectPath).getSignedUrl({
        version: "v4",
        action: "read",
        expires: expiresAt,
        // The file is whatever a shell produced, so a browser only ever saves
        // it. Both are signed with the URL, so its holder cannot change them.
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
const iso = (ms: number) => new Date(ms).toISOString();
const NO_SESSION = "Session not found or expired. Create a new session.";
// A session is live until its end by the database's clock, the one clock
// every replica shares: by their own, one replica could still count a session
// another just ended.
const live = gt(sessions.expires_at, sql`clock_timestamp()`);

/**
 * Records a new session and returns the ids of the sessions it ended. A team
 * at the limit of live sessions gives up the ones saved longest ago, so
 * sessions nobody returns to never keep a team from starting one. A team's
 * creations run one at a time, so concurrent ones cannot pass the limit
 * together.
 */
async function insertSession(
  teamId: string,
  id: string,
  now: number,
  expiresAt: number,
): Promise<string[]> {
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
    await tx.insert(sessions).values({
      id,
      team_id: teamId,
      created_at: iso(now),
      expires_at: iso(expiresAt),
    });
    return ended.map(session => session.id);
  });
}

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
  // Zero data retention forced on scrapes, on searches or by Safe Mode
  // lockdown covers everything the team does, as it does in the hosted MCP.
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

async function send(res: Response, file: StoredFile, body: Readable) {
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(file.sizeBytes));
  res.setHeader("Cache-Control", "private, no-store");
  try {
    await pipeline(body, res);
  } catch (error) {
    // The headers are out, so there is no error response left to send.
    logger.warn("Computer session file stream ended early", { error });
  }
}

/** Answers a call its limiter refused, or returns false for any other failure. */
function tooMany(res: Response, rejection: unknown, limit: string): boolean {
  if (!(rejection instanceof RateLimiterRes)) return false;
  const seconds = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000));
  res.setHeader("Retry-After", String(seconds));
  refuse(res, 429, `${limit} Try again in ${seconds} seconds.`);
  return true;
}

// A session's workspace is one object, absent until the first save.
const teamPrefix = (teamId: string) =>
  `workspaces/${encodeURIComponent(teamId)}/`;

const EMPTY_WORKSPACE: StoredFile = {
  sizeBytes: 0,
  version: "0",
  open: async () => Readable.from([]),
};

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
    const id = req.params.sessionId;
    const [session] = SESSION_ID.test(id)
      ? await db
          .select({
            created_at: sessions.created_at,
            last_saved_at: sessions.last_saved_at,
          })
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
      objectPath: teamPrefix(teamId) + id,
      createdAt: new Date(session.created_at).getTime(),
      saved: session.last_saved_at !== null,
    };
  }

  /**
   * Deletes an ended session's workspace now, not when the bucket clears it,
   * so ended sessions hold no storage. A failure leaves it to the bucket.
   */
  async function discardWorkspace(teamId: string, sessionId: string) {
    try {
      await store.delete(teamPrefix(teamId) + sessionId);
    } catch (error) {
      logger.warn("Computer session workspace not deleted", {
        teamId,
        sessionId,
        error,
      });
    }
  }

  return {
    /** Starts a session: an id only this team can use, with an empty workspace. */
    async createSession(req: RequestWithAuth<{}, any, any>, res: Response) {
      const teamId = hostedMcpTeam(req, res);
      if (teamId === null) return;
      const id = crypto.randomUUID();
      const now = Date.now();
      const expiresAt = now + SESSION_IDLE_SECONDS * 1000;
      const ended = await insertSession(teamId, id, now, expiresAt);
      // Otherwise starting sessions would store more than the limit holds.
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

    /**
     * Stores the session's workspace, replacing the one saved before, and
     * moves the session's end out.
     */
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

      // Taken before the write, so the session never outlives its workspace.
      const savedAt = Date.now();
      let version: string;
      try {
        version = await store.write(session.objectPath, bodyOf(req, res), {
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
      const end = Math.min(
        savedAt + SESSION_IDLE_SECONDS * 1000,
        session.createdAt + SESSION_MAX_SECONDS * 1000,
      );
      // Never moved back, so a slow save that began earlier cannot shorten
      // what a later one set. Only a session that is still live is moved: one
      // that ended during the upload, by its time or to make room for another,
      // stays ended, and what this save stored for it goes.
      const [extended] = await db
        .update(sessions)
        .set({
          last_saved_at: sql`GREATEST(${sessions.last_saved_at}, ${iso(savedAt)}::timestamptz)`,
          expires_at: sql`GREATEST(${sessions.expires_at}, ${iso(end)}::timestamptz)`,
        })
        .where(and(eq(sessions.id, session.id), live))
        .returning({ expires_at: sessions.expires_at });
      if (!extended) {
        await discardWorkspace(teamId, session.id);
        return refuse(res, 404, NO_SESSION);
      }
      res.setHeader("ETag", `"${version}"`);
      res.status(200).json({
        success: true,
        data: {
          sizeBytes,
          version,
          expiresAt: new Date(extended.expires_at).toISOString(),
        },
      });
    },

    async readWorkspace(req: SessionRequest, res: Response) {
      const teamId = hostedMcpTeam(req, res);
      if (teamId === null) return;
      const session = await liveSession(req, res, teamId);
      if (!session) return;
      for (let attempt = 1; ; attempt++) {
        const stored = await store.read(session.objectPath);
        // A saved workspace that is gone is said so, not passed off as empty.
        if (!stored && session.saved) {
          return refuse(
            res,
            410,
            "This session's files are no longer stored. Create a new session.",
          );
        }
        const workspace = stored ?? EMPTY_WORKSPACE;
        let body: Readable;
        try {
          body = await workspace.open();
        } catch (error) {
          // A save landed between finding the workspace and reading it, so
          // the one it stored is read instead.
          const replaced = error instanceof VersionReplacedError;
          if (replaced && attempt < READ_ATTEMPTS) continue;
          throw error;
        }
        res.setHeader("ETag", `"${workspace.version}"`);
        return send(res, workspace, body);
      }
    },

    /**
     * Stores the file in the body and returns a link anyone can download it
     * from until it expires.
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
        const limit =
          "This team has reached its hourly limit for download links.";
        if (tooMany(res, rejection, limit)) return;
        throw rejection;
      }

      const filename =
        path
          .basename(query.data.filename)
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .replace(/^\.+/, "") || "download";
      // The signature is the only way to the file, so its object only needs a
      // name no other link has.
      const linkId = crypto.randomUUID();
      const objectPath = `links/${linkId}/${filename}`;
      let expiresAt: number;
      let url: string;
      try {
        await store.write(objectPath, bodyOf(req, res));
        // Counted from the end of the upload, so a slow one takes none of the
        // link's time.
        expiresAt = Date.now() + query.data.expiresInSeconds * 1000;
        url = await store.downloadUrl(objectPath, filename, expiresAt);
      } catch (error) {
        // No link came of it, so nothing counts against the team's hour.
        await linkLimit.reward(teamId, mebibytes).catch(() => {});
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
        data: { url, expiresAt: iso(expiresAt), sizeBytes },
      });
    },
  };
}

/**
 * The session file handlers, or null on a deployment that names no bucket for
 * them.
 */
export function configuredComputerSessionFiles() {
  const bucket = config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME;
  if (!bucket) return null;
  const hour = { points: LINK_MEBIBYTES_PER_HOUR, duration: 60 * 60 };
  const memory = new RateLimiterMemory(hour);
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
  );
}
