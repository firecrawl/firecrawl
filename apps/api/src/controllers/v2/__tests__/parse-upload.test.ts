import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    ENV: "production" as string | undefined,
    PARSE_UPLOAD_REF_SECRET: "test-upload-ref-secret" as string | undefined,
    PARSE_UPLOAD_PUBLIC_BASE_URL: undefined as string | undefined,
  },
  redisEval: vi.fn(),
  pipelineExec: vi.fn(),
  imageOcrEnabled: false,
  detectUploadedFileKind: vi.fn(
    (
      filename: string,
      _contentType?: string,
      _imageOcrEnabled?: boolean,
    ): string | null => {
      if (filename.endsWith(".html")) return "html";
      if (filename.endsWith(".pdf")) return "pdf";
      return null;
    },
  ),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../../../config", () => ({
  config: mocks.config,
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock("../../../lib/otel-tracer", () => ({
  withSpan: async (_name: string, fn: (span: unknown) => Promise<unknown>) =>
    fn({}),
  setSpanAttributes: vi.fn(),
}));

vi.mock("../../../services/queue-service", () => ({
  getRedisConnection: () => ({
    eval: mocks.redisEval,
    pipeline: () => {
      const chain = {
        zremrangebyscore: () => chain,
        zrem: () => chain,
        expire: () => chain,
        exec: mocks.pipelineExec,
      };
      return chain;
    },
  }),
}));

vi.mock("../parse", () => ({
  detectUploadedFileKind: (
    filename: string,
    contentType: string | undefined,
    imageOcrEnabled: boolean,
  ) => mocks.detectUploadedFileKind(filename, contentType, imageOcrEnabled),
  getSupportedParseFileTypes: () => ".pdf, .html",
}));

vi.mock("../../../lib/image-ocr-gate", () => ({
  isImageOcrEnabled: () => mocks.imageOcrEnabled,
}));

import {
  parseLocalUploadController,
  parseLocalUploadStorageGuard,
  parseUploadRefPayloadMiddleware,
  parseUploadUrlController,
} from "../parse-upload";
import {
  coreParts,
  createService,
  defaultModules,
  type UploadDriver,
  type UploadsModule,
} from "../../../service";
import { replaceService } from "../../../service/service";
import { testService, withService } from "../../../service/testing";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/v2/parse/upload-url", (req, res, next) => {
    (req as any).auth = { team_id: "team-1" };
    parseUploadUrlController(req as any, res).catch(next);
  });
  app.put(
    "/v2/parse/upload/:uploadId",
    parseLocalUploadStorageGuard,
    express.raw({ type: "*/*", limit: "50mb" }),
    (req, res, next) => {
      parseLocalUploadController(req, res).catch(next);
    },
  );
  app.post(
    "/v2/parse",
    (req, _res, next) => {
      (req as any).auth = { team_id: "team-1" };
      next();
    },
    (req, res, next) => {
      parseUploadRefPayloadMiddleware(req as any, res, next).catch(next);
    },
    (req, res) => {
      res.status(200).json({
        success: true,
        filename: req.body.file.filename,
        kind: req.body.file.kind,
        content: req.body.file.buffer.toString("utf8"),
      });
    },
  );
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ success: false, error: err.message });
    },
  );
  return app;
}

beforeEach(() => {
  mocks.config.ENV = "production";
  mocks.config.PARSE_UPLOAD_REF_SECRET = "test-upload-ref-secret";
  mocks.config.PARSE_UPLOAD_PUBLIC_BASE_URL = undefined;
  mocks.redisEval.mockReset().mockResolvedValue(-1);
  mocks.pipelineExec.mockReset().mockResolvedValue([
    [null, 0],
    [null, 1],
    [null, 1],
  ]);
  mocks.detectUploadedFileKind.mockReset().mockImplementation(filename => {
    if (filename.endsWith(".html")) return "html";
    if (filename.endsWith(".pdf")) return "pdf";
    return null;
  });
  mocks.loggerWarn.mockReset();
  mocks.loggerError.mockReset();
  replaceService(createService({}, coreParts()));
});

afterEach(() => {
  replaceService(undefined);
});

describe("parse-upload with default memoryUploads", () => {
  it.each(["production", "staging", "development", "test", "local", undefined])(
    "allows local uploads unconditionally when ENV=%s",
    async envValue => {
      mocks.config.ENV = envValue;
      const app = buildApp();

      const init = await request(app)
        .post("/v2/parse/upload-url")
        .send({ filename: "sample.html", contentType: "text/html" });

      expect(init.status).toBe(200);
      expect(init.body.success).toBe(true);
      expect(init.body.data.method).toBe("PUT");
      expect(init.body.data.fields).toBeUndefined();

      const uploadUrl = new URL(init.body.data.uploadUrl);
      const put = await request(app)
        .put(`${uploadUrl.pathname}${uploadUrl.search}`)
        .set("Content-Type", "text/html")
        .send("<h1>ok</h1>");
      expect(put.status).toBe(200);

      const parsed = await request(app)
        .post("/v2/parse")
        .send({ uploadRef: init.body.data.uploadRef });
      expect(parsed.status).toBe(200);
      expect(parsed.body).toEqual({
        success: true,
        filename: "sample.html",
        kind: "html",
        content: "<h1>ok</h1>",
      });

      // Second parse fails because finish cleaned up the staged upload.
      const second = await request(app)
        .post("/v2/parse")
        .send({ uploadRef: init.body.data.uploadRef });
      expect(second.status).toBe(400);
      expect(second.body.error).toContain("not available");
    },
  );
});

describe("parse-upload with custom external driver", () => {
  it("disables direct PUT uploads when the driver omits receiveUpload", async () => {
    const app = buildApp();
    const externalDriver: UploadDriver = {
      name: "external",
      prepareUpload: vi.fn(),
      read: vi.fn(),
      delete: vi.fn(),
    };
    const uploads: UploadsModule = { driver: () => externalDriver };

    await withService(
      testService(defaultModules(), coreParts(), { uploads }),
      async () => {
        const res = await request(app)
          .put("/v2/parse/upload/upload-1?uploadRef=anything")
          .send("body");

        expect(res.status).toBe(404);
        expect(res.body).toEqual({
          success: false,
          code: "NOT_FOUND",
          error: "Local parse upload storage is disabled.",
        });
      },
    );
  });

  it("propagates disabled storage responses before reserving quota", async () => {
    const app = buildApp();
    const externalDriver: UploadDriver = {
      name: "external",
      prepareUpload: vi.fn(async () => ({
        ok: false as const,
        status: 503,
        code: "PARSE_UPLOAD_STORAGE_DISABLED",
        error: "Parse upload storage is not configured.",
      })),
      read: vi.fn(),
      delete: vi.fn(),
    };

    await withService(
      testService(defaultModules(), coreParts(), {
        uploads: { driver: () => externalDriver },
      }),
      async () => {
        const res = await request(app)
          .post("/v2/parse/upload-url")
          .send({ filename: "doc.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(503);
        expect(res.body).toEqual({
          success: false,
          code: "PARSE_UPLOAD_STORAGE_DISABLED",
          error: "Parse upload storage is not configured.",
        });
        expect(mocks.redisEval).not.toHaveBeenCalled();
      },
    );
  });

  it("commits after quota reservation, releases quota on commit failure, and resolves via driver", async () => {
    const app = buildApp();
    const commit = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const read = vi.fn(async () => Buffer.from("%PDF-1.7"));
    const del = vi.fn(async () => {});
    const externalDriver: UploadDriver = {
      name: "external",
      prepareUpload: vi.fn(async () => ({
        ok: true as const,
        target: {
          uploadUrl: "https://storage.example/bucket",
          method: "POST" as const,
          headers: {},
          fields: { key: "parse-uploads/team-1/u/doc.pdf" },
        },
        commit,
      })),
      read,
      delete: del,
    };

    await withService(
      testService(defaultModules(), coreParts(), {
        uploads: { driver: () => externalDriver },
      }),
      async () => {
        const init = await request(app)
          .post("/v2/parse/upload-url")
          .send({ filename: "doc.pdf", contentType: "application/pdf" });

        expect(init.status).toBe(200);
        expect(init.body.data).toMatchObject({
          uploadUrl: "https://storage.example/bucket",
          method: "POST",
          headers: {},
          fields: { key: "parse-uploads/team-1/u/doc.pdf" },
        });
        expect(mocks.redisEval).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(mocks.redisEval.mock.invocationCallOrder[0]).toBeLessThan(
          commit.mock.invocationCallOrder[0],
        );

        const parsed = await request(app)
          .post("/v2/parse")
          .send({ uploadRef: init.body.data.uploadRef });

        expect(parsed.status).toBe(200);
        expect(parsed.body).toEqual({
          success: true,
          filename: "doc.pdf",
          kind: "pdf",
          content: "%PDF-1.7",
        });
        expect(read).toHaveBeenCalledTimes(1);
        expect(del).toHaveBeenCalledTimes(1);

        // Commit error releases the Redis quota reservation.
        mocks.pipelineExec.mockClear();
        commit.mockRejectedValueOnce(new Error("cleanup queue unavailable"));
        const failed = await request(app)
          .post("/v2/parse/upload-url")
          .send({ filename: "doc.pdf", contentType: "application/pdf" });
        expect(failed.status).toBe(500);
        expect(mocks.pipelineExec).toHaveBeenCalledTimes(1);

        // Per-command Redis pipeline error during rollback is reported and handled.
        mocks.pipelineExec.mockClear();
        mocks.loggerError.mockClear();
        mocks.loggerWarn.mockClear();
        const pipelineError = new Error("redis pipeline failed");
        mocks.pipelineExec.mockResolvedValueOnce([
          [pipelineError, null],
          [null, 0],
          [null, 0],
        ]);
        commit.mockRejectedValueOnce(new Error("cleanup queue unavailable"));
        const rollbackFailed = await request(app)
          .post("/v2/parse/upload-url")
          .send({ filename: "doc.pdf", contentType: "application/pdf" });
        expect(rollbackFailed.status).toBe(500);
        expect(rollbackFailed.body.error).toBe("cleanup queue unavailable");
        expect(mocks.loggerError).toHaveBeenCalledWith(
          "Redis pipeline command failed",
          expect.objectContaining({
            module: "parse-upload",
            method: "releaseUnparsedUploadRef",
            error: pipelineError,
          }),
        );
        expect(mocks.loggerWarn).toHaveBeenCalledWith(
          "Failed to release rejected parse upload",
          expect.objectContaining({
            error: expect.any(Error),
          }),
        );
      },
    );
  });

  it("rejects uploadRefs minted for a different driver", async () => {
    const app = buildApp();
    const init = await request(app)
      .post("/v2/parse/upload-url")
      .send({ filename: "sample.html", contentType: "text/html" });
    expect(init.status).toBe(200);

    const externalDriver: UploadDriver = {
      name: "external",
      prepareUpload: vi.fn(),
      read: vi.fn(),
      delete: vi.fn(),
    };

    await withService(
      testService(defaultModules(), coreParts(), {
        uploads: { driver: () => externalDriver },
      }),
      async () => {
        const parsed = await request(app)
          .post("/v2/parse")
          .send({ uploadRef: init.body.data.uploadRef });

        expect(parsed.status).toBe(400);
        expect(parsed.body.error).toContain("does not match");
        expect(externalDriver.read).not.toHaveBeenCalled();
      },
    );
  });
});
