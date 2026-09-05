import crypto from "node:crypto";
const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  cleanup: vi.fn(),
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
          getMetadata: async () => [{ size: 3 }],
          download: async () => [Buffer.from("pdf")],
          delete: mocks.cleanup,
        }),
      };
    }
  },
}));
vi.mock("../parse", () => ({
  detectUploadedFileKind: () => "pdf",
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
function request() {
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
});
it("releases Redis quota before continuing to the parse response", async () => {
  mocks.exec.mockResolvedValue([
    [null, 0],
    [null, 1],
    [null, 1],
  ]);
  const next = vi.fn();
  await parseUploadRefPayloadMiddleware(
    request(),
    { once: vi.fn() } as any,
    next,
  );
  expect(mocks.exec).toHaveBeenCalled();
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
