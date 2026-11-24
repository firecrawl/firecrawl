import crypto from "node:crypto";
import path from "node:path";
import { Request, Response, NextFunction } from "express";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import { getRedisConnection } from "../../services/queue-service";
import { RequestWithAuth, UploadedParseFile } from "./types";
import { detectUploadedFileKind, getSupportedParseFileTypes } from "./parse";
import { isImageOcrEnabled } from "../../lib/image-ocr-gate";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { reportPipelineError } from "../../lib/redis-pipeline";
import { service, type StoredUploadRef } from "../../service";

const PARSE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const PARSE_UPLOAD_TTL_MS = 10 * 60 * 1000;
const PARSE_UPLOAD_UNPARSED_LIMIT = 10;
const PARSE_UPLOAD_UNPARSED_WINDOW_MS = 24 * 60 * 60 * 1000;
const PARSE_UPLOAD_UNPARSED_TTL_SECONDS = 25 * 60 * 60;
const uploadInitSchema = z.strictObject({
  filename: z.string().min(1).max(512),
  contentType: z.string().min(1).max(255).optional(),
  declaredSizeBytes: z
    .number()
    .int()
    .positive()
    .max(PARSE_UPLOAD_MAX_BYTES)
    .optional(),
});

type ParseUploadRefPayload = {
  v: 1;
  driver: string;
  uploadId: string;
  teamId: string;
  objectPath: string;
  filename: string;
  contentType?: string;
  expiresAt: number;
  maxBytes: number;
};

function getEffectiveRefSecret(): string | null {
  return config.PARSE_UPLOAD_REF_SECRET ?? null;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function signUploadRef(payload: ParseUploadRefPayload): string {
  const secret = getEffectiveRefSecret();
  if (!secret) {
    throw new Error(
      "PARSE_UPLOAD_REF_SECRET is required for parse upload refs.",
    );
  }

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

function verifyUploadRef(uploadRef: string): ParseUploadRefPayload {
  const secret = getEffectiveRefSecret();
  if (!secret) {
    throw new Error(
      "PARSE_UPLOAD_REF_SECRET is required for parse upload refs.",
    );
  }

  const [encodedPayload, signature, extra] = uploadRef.split(".");
  if (!encodedPayload || !signature || extra !== undefined) {
    throw new Error("Invalid uploadRef format.");
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid uploadRef signature.");
  }

  const decoded = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
  const parsed = z
    .strictObject({
      v: z.literal(1),
      driver: z.string().min(1),
      uploadId: z.string().min(1),
      teamId: z.string().min(1),
      objectPath: z.string().min(1),
      filename: z.string().min(1),
      contentType: z.string().optional(),
      expiresAt: z.number().int().positive(),
      maxBytes: z.number().int().positive().max(PARSE_UPLOAD_MAX_BYTES),
    })
    .parse(decoded);

  if (Date.now() > parsed.expiresAt) {
    throw new Error("uploadRef has expired.");
  }

  return parsed;
}

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base || "upload";
}

function isSupportedParseUpload(
  filename: string,
  contentType: string | undefined,
  imageOcrEnabled: boolean,
) {
  return (
    detectUploadedFileKind(filename, contentType, imageOcrEnabled) !== null
  );
}

function buildPublicBaseUrl(req: Request): string {
  const configured = config.PARSE_UPLOAD_PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  return `${req.protocol}://${req.host}`;
}

function makeObjectPath(
  teamId: string,
  uploadId: string,
  filename: string,
): string {
  return `parse-uploads/${teamId}/${uploadId}/${sanitizeFilename(filename)}`;
}

function getUnparsedUploadsKey(teamId: string) {
  return `parse-upload-refs:${teamId}`;
}

async function reserveUnparsedUploadRef(teamId: string, uploadId: string) {
  const now = Date.now();
  const cutoff = now - PARSE_UPLOAD_UNPARSED_WINDOW_MS;
  const result = await getRedisConnection().eval(
    `
      redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
      local count = redis.call("ZCARD", KEYS[1])
      if count >= tonumber(ARGV[3]) then
        redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))
        return count
      end
      redis.call("ZADD", KEYS[1], ARGV[2], ARGV[4])
      redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))
      return -1
    `,
    1,
    getUnparsedUploadsKey(teamId),
    cutoff,
    now,
    PARSE_UPLOAD_UNPARSED_LIMIT,
    uploadId,
    PARSE_UPLOAD_UNPARSED_TTL_SECONDS,
  );

  if (Number(result) !== -1) {
    throw new Error("PARSE_UPLOAD_UNPARSED_LIMIT_REACHED");
  }
}

async function releaseUnparsedUploadRef(teamId: string, uploadId: string) {
  const cutoff = Date.now() - PARSE_UPLOAD_UNPARSED_WINDOW_MS;
  const key = getUnparsedUploadsKey(teamId);
  const results = await getRedisConnection()
    .pipeline()
    .zremrangebyscore(key, "-inf", cutoff)
    .zrem(key, uploadId)
    .expire(key, PARSE_UPLOAD_UNPARSED_TTL_SECONDS)
    .exec();
  // Both call sites catch and log a throw here; a leaked ref self-expires
  // via TTL.
  const error = reportPipelineError(results, _logger, {
    module: "parse-upload",
    method: "releaseUnparsedUploadRef",
    teamId,
    uploadId,
  });
  if (error) {
    throw new Error("Failed to release unparsed upload ref: " + error.message, {
      cause: error,
    });
  }
}

async function reserveUnparsedUploadRefOrRespond(
  res: Response,
  teamId: string,
  uploadId: string,
) {
  try {
    await reserveUnparsedUploadRef(teamId, uploadId);
    return false;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "PARSE_UPLOAD_UNPARSED_LIMIT_REACHED"
    ) {
      res.status(429).json({
        success: false,
        code: "PARSE_UPLOAD_UNPARSED_LIMIT_REACHED",
        error:
          "Too many unparsed uploads. Parse or wait for existing upload references before minting more.",
      });
      return true;
    }

    throw error;
  }
}

export async function parseUploadUrlController(
  req: RequestWithAuth<{}, any, any>,
  res: Response,
) {
  return withSpan(
    "api.parse.upload_url",
    async span => {
      const parsed = uploadInitSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          code: "BAD_REQUEST",
          error:
            parsed.error.issues[0]?.message ?? "Invalid upload init request.",
        });
      }

      const { filename, contentType, declaredSizeBytes } = parsed.data;
      const imageOcrEnabled = isImageOcrEnabled();
      if (!isSupportedParseUpload(filename, contentType, imageOcrEnabled)) {
        return res.status(400).json({
          success: false,
          code: "UNSUPPORTED_FILE_TYPE",
          error: `Unsupported upload type. Supported file extensions include ${getSupportedParseFileTypes(imageOcrEnabled)}, or matching supported MIME types.`,
        });
      }

      if (!getEffectiveRefSecret()) {
        return res.status(503).json({
          success: false,
          code: "PARSE_UPLOAD_REF_SECRET_MISSING",
          error: "Parse upload references are not configured.",
        });
      }

      const driver = service.modules.uploads.driver();
      const uploadId = uuidv7();
      const expiresAt = Date.now() + PARSE_UPLOAD_TTL_MS;
      const sanitizedFilename = sanitizeFilename(filename);
      const objectPath = makeObjectPath(
        req.auth.team_id,
        uploadId,
        sanitizedFilename,
      );
      const refPayload: ParseUploadRefPayload = {
        v: 1,
        driver: driver.name,
        uploadId,
        teamId: req.auth.team_id,
        objectPath,
        filename: sanitizedFilename,
        contentType,
        expiresAt,
        maxBytes: PARSE_UPLOAD_MAX_BYTES,
      };
      const uploadRef = signUploadRef(refPayload);

      setSpanAttributes(span, {
        "parse_upload.driver": driver.name,
        "parse_upload.team_id": req.auth.team_id,
        "parse_upload.declared_size": declaredSizeBytes,
      });

      const prepared = await driver.prepareUpload({
        uploadId,
        teamId: req.auth.team_id,
        objectPath,
        filename: sanitizedFilename,
        contentType,
        expiresAt,
        maxBytes: PARSE_UPLOAD_MAX_BYTES,
        uploadRef,
        publicBaseUrl: buildPublicBaseUrl(req),
      });
      if (!prepared.ok) {
        return res.status(prepared.status).json({
          success: false,
          code: prepared.code,
          error: prepared.error,
        });
      }

      if (
        await reserveUnparsedUploadRefOrRespond(res, req.auth.team_id, uploadId)
      ) {
        return;
      }

      if (prepared.commit) {
        try {
          await prepared.commit();
        } catch (error) {
          await releaseRejectedUploadRef(refPayload);
          throw error;
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          uploadUrl: prepared.target.uploadUrl,
          uploadRef,
          method: prepared.target.method,
          headers: prepared.target.headers,
          ...(prepared.target.fields ? { fields: prepared.target.fields } : {}),
          expiresAt: new Date(expiresAt).toISOString(),
          maxSizeBytes: PARSE_UPLOAD_MAX_BYTES,
        },
      });
    },
    { zeroDataRetention: getScrapeZDR(req.acuc?.flags) === "forced" },
  );
}

export async function parseLocalUploadController(req: Request, res: Response) {
  const driver = service.modules.uploads.driver();
  if (!driver.receiveUpload) {
    return res.status(404).json({
      success: false,
      code: "NOT_FOUND",
      error: "Local parse upload storage is disabled.",
    });
  }

  const uploadRef =
    typeof req.query.uploadRef === "string" ? req.query.uploadRef : "";
  let payload: ParseUploadRefPayload;
  try {
    payload = verifyUploadRef(uploadRef);
  } catch (error) {
    return res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      error: error instanceof Error ? error.message : "Invalid uploadRef.",
    });
  }

  if (
    payload.driver !== driver.name ||
    payload.uploadId !== req.params.uploadId
  ) {
    return res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      error: "uploadRef does not match this upload URL.",
    });
  }

  const body = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(req.body ?? "");
  const stored = await driver.receiveUpload({
    uploadId: payload.uploadId,
    teamId: payload.teamId,
    body,
  });
  if (!stored.ok) {
    return res.status(stored.status).json({
      success: false,
      code: stored.code,
      error: stored.error,
    });
  }

  return res.status(200).json({ success: true });
}

export function parseLocalUploadStorageGuard(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!service.modules.uploads.driver().receiveUpload) {
    return res.status(404).json({
      success: false,
      code: "NOT_FOUND",
      error: "Local parse upload storage is disabled.",
    });
  }

  next();
}

async function releaseRejectedUploadRef(payload: ParseUploadRefPayload) {
  try {
    await releaseUnparsedUploadRef(payload.teamId, payload.uploadId);
  } catch (error) {
    _logger.warn("Failed to release rejected parse upload", {
      error,
      uploadId: payload.uploadId,
    });
  }
}

async function resolveUploadRef(
  payload: ParseUploadRefPayload,
  imageOcrEnabled: boolean,
): Promise<{
  file: UploadedParseFile;
  cleanup: () => Promise<void>;
}> {
  const driver = service.modules.uploads.driver();
  if (payload.driver !== driver.name) {
    throw new Error("uploadRef does not match configured upload storage.");
  }

  const storedRef: StoredUploadRef = {
    uploadId: payload.uploadId,
    teamId: payload.teamId,
    objectPath: payload.objectPath,
    maxBytes: payload.maxBytes,
  };
  const buffer = await driver.read(storedRef);
  if (buffer.length > payload.maxBytes) {
    throw new Error("Uploaded file exceeds maximum size of 50MB.");
  }

  const kind = detectUploadedFileKind(
    payload.filename,
    payload.contentType,
    imageOcrEnabled,
  );
  if (!kind) {
    // The type was accepted when the upload URL was minted, so this only
    // happens when eligibility changed in between (e.g. image OCR was
    // switched off). Discard the upload instead of stranding it and
    // its quota reservation.
    try {
      await driver.delete(storedRef);
    } catch (error) {
      _logger.warn("Failed to delete rejected parse upload object", {
        error,
        uploadId: payload.uploadId,
      });
    }
    await releaseRejectedUploadRef(payload);
    throw new Error("Unsupported upload type.");
  }

  return {
    file: {
      buffer,
      filename: payload.filename,
      contentType: payload.contentType,
      kind,
    },
    cleanup: async () => {
      try {
        await driver.delete(storedRef);
      } catch (error) {
        _logger.warn("Failed to clean up parse upload object", {
          error,
          uploadId: payload.uploadId,
        });
      }
    },
  };
}

export async function parseUploadRefPayloadMiddleware(
  req: RequestWithAuth<{}, any, any>,
  res: Response,
  next: NextFunction,
) {
  const uploadRef = req.body?.uploadRef;
  if (typeof uploadRef !== "string" || uploadRef.length === 0) {
    res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      error:
        "Missing file upload. Send multipart/form-data with a 'file' field, or JSON with an 'uploadRef'.",
    });
    return;
  }

  let payload: ParseUploadRefPayload;
  try {
    payload = verifyUploadRef(uploadRef);
  } catch (error) {
    res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      error: error instanceof Error ? error.message : "Invalid uploadRef.",
    });
    return;
  }

  if (payload.teamId !== req.auth.team_id) {
    res.status(403).json({
      success: false,
      code: "FORBIDDEN",
      error: "uploadRef does not belong to the authenticated team.",
    });
    return;
  }

  try {
    const resolved = await resolveUploadRef(payload, isImageOcrEnabled());
    const { uploadRef: _uploadRef, ...options } = req.body;
    req.body = {
      ...options,
      file: resolved.file,
    };
    res.once("finish", () => {
      Promise.all([
        resolved.cleanup(),
        releaseUnparsedUploadRef(payload.teamId, payload.uploadId),
      ]).catch(error => {
        _logger.warn("Failed to clean up parse upload", {
          error,
          uploadId: payload.uploadId,
        });
      });
    });
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      error:
        error instanceof Error ? error.message : "Failed to resolve uploadRef.",
    });
  }
}
