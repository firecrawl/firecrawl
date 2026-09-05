import crypto from "node:crypto";
const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  cleanup: vi.fn(),
  metadata: vi.fn(),
  download: vi.fn(),
  kind: vi.fn(),
  secret: "test-signing-secret",
}));
vi.mock("../../../config", () => ({
  config: {
    PARSE_UPLOAD_REF_SECRET: mocks.secret,
    GCS_PARSE_UPLOAD_BUCKET_NAME: "test",
  },
}));
vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket() {
      return {
        file: () => ({
          getMetadata: mocks.metadata,
          download: mocks.download,
          delete: mocks.cleanup,
        }),
      };
    }
  },
}));
vi.mock("../parse", () => ({
  detectUploadedFileKind: mocks.kind,
  getSupportedParseFileTypes: () => [],
}));
vi.mock("../../../lib/otel-tracer", () => ({
  withSpan: vi.fn(),
  setSpanAttributes: vi.fn(),
}));
vi.mock("../../../lib/image-ocr-gate", () => ({
  isImageOcrEnabled: () => false,
}));
vi.mock("../../../services/queue-service", () => ({
  getRedisConnection: () => ({
    pipeline: () => {
      const pipeline = {
        zremrangebyscore: () => pipeline,
        zrem: () => pipeline,
        expire: () => pipeline,
        exec: mocks.exec,
      };
      return pipeline;
    },
  }),
}));
import { parseUploadRefPayloadMiddleware } from "../parse-upload";
function request(overrides: Record<string, unknown> = {}) {
  const encoded = Buffer.from(
    JSON.stringify({
      v: 1,
      driver: "gcs",
      teamId: "team",
      uploadId: "upload",
      objectPath: "test.pdf",
      filename: "test.pdf",
      contentType: "application/pdf",
      expiresAt: Date.now() + 60000,
      maxBytes: 100,
      ...overrides,
    }),
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", mocks.secret)
    .update(encoded)
    .digest("base64url");
  return {
    auth: { team_id: "team" },
    body: { uploadRef: `${encoded}.${signature}` },
  } as any;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cleanup.mockResolvedValue(undefined);
  mocks.metadata.mockResolvedValue([{ size: 3 }]);
  mocks.download.mockResolvedValue([Buffer.from("pdf")]);
  mocks.kind.mockReturnValue("pdf");
  mocks.exec.mockResolvedValue([
    [null, 0],
    [null, 1],
    [null, 1],
  ]);
});
it("releases Redis quota before continuing to the parse response", async () => {
  let resolveExec!: (value: unknown) => void;
  const entered = new Promise<void>(resolve => {
    mocks.exec.mockImplementation(() => {
      resolve();
      return new Promise(done => {
        resolveExec = done;
      });
    });
  });
  const next = vi.fn();
  const pending = parseUploadRefPayloadMiddleware(
    request(),
    { once: vi.fn() } as any,
    next,
  );
  await entered;
  expect(next).not.toHaveBeenCalled();
  resolveExec([
    [null, 0],
    [null, 1],
    [null, 1],
  ]);
  await pending;
  expect(next).toHaveBeenCalledWith();
});

it("propagates the original quota error and cleans the upload before any success response", async () => {
  const error = new Error("WRONGTYPE original Redis failure");
  mocks.exec.mockResolvedValue([
    [error, null],
    [null, 1],
    [null, 1],
  ]);
  const next = vi.fn();
  const res = { once: vi.fn(), status: vi.fn(), json: vi.fn() } as any;
  await expect(
    parseUploadRefPayloadMiddleware(request(), res, next),
  ).rejects.toBe(error);
  expect(mocks.cleanup).toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
});

function response() {
  return {
    once: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as any;
}
it.each([
  [
    "missing local file",
    () => {},
    { driver: "local" },
    "Uploaded file is not available. Upload the file before parsing.",
  ],
  [
    "oversized metadata",
    () => mocks.metadata.mockResolvedValue([{ size: 101 }]),
    {},
    "Uploaded file exceeds maximum size of 50MB.",
  ],
  [
    "oversized download",
    () => mocks.download.mockResolvedValue([Buffer.alloc(101)]),
    {},
    "Uploaded file exceeds maximum size of 50MB.",
  ],
  [
    "unsupported type",
    () => mocks.kind.mockReturnValue(null),
    {},
    "Unsupported upload type.",
  ],
] as const)("returns 400 for %s", async (_name, setup, overrides, message) => {
  setup();
  const res = response();
  const next = vi.fn();
  await parseUploadRefPayloadMiddleware(request(overrides), res, next);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({
    success: false,
    code: "BAD_REQUEST",
    error: message,
  });
  expect(next).not.toHaveBeenCalled();
});
it("preserves Redis failure while releasing an unsupported upload", async () => {
  const error = new Error("original Redis failure");
  mocks.kind.mockReturnValue(null);
  mocks.exec.mockRejectedValue(error);
  const res = response();
  await expect(
    parseUploadRefPayloadMiddleware(request(), res, vi.fn()),
  ).rejects.toBe(error);
  expect(res.status).not.toHaveBeenCalled();
});
it("preserves unexpected storage failures", async () => {
  const error = new Error("storage unavailable");
  mocks.metadata.mockRejectedValue(error);
  const res = response();
  await expect(
    parseUploadRefPayloadMiddleware(request(), res, vi.fn()),
  ).rejects.toBe(error);
  expect(res.status).not.toHaveBeenCalled();
});
it("preserves both Redis and upload cleanup failures", async () => {
  const error = new Error("original Redis failure");
  const cleanupError = new Error("storage deletion failed");
  mocks.exec.mockRejectedValue(error);
  mocks.cleanup.mockRejectedValue(cleanupError);
  await expect(
    parseUploadRefPayloadMiddleware(request(), response(), vi.fn()),
  ).rejects.toMatchObject({ errors: [error, cleanupError] });
});
