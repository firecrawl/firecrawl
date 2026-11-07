import { describe, expect, it, vi } from "vitest";

// fireEngineScrape talks to fire-engine through robustFetch; swap it for a
// controllable stub so the POST /scrape response shape is the only variable.
const fetchFake = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
}));

vi.mock("../../../lib/fetch", () => ({
  robustFetch: vi.fn(async () => fetchFake.status),
}));

vi.mock("../../../../../lib/gcs-jobs", () => ({
  getDocFromGCS: vi.fn(async () => null),
}));

import { fireEngineFileSchema } from "../fileSchema";
import { fireEngineScrape } from "../scrape";

const fakeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child() {
    return this;
  },
} as any;

const fakeMeta = {
  options: { proxy: "auto" },
  featureFlags: new Set<string>(),
} as any;

const request = {
  url: "https://example.com/report.pdf",
  engine: "chrome-cdp",
  timeout: 30000,
} as any;

// Mirrors the shape fire-engine returns for a large-PDF handoff: no inline
// bytes, a GCS reference plus the content identity, and an empty `content`.
const handoffStatus = {
  timeTaken: 20.5,
  content: "",
  url: "https://example.com/report.pdf",
  pageStatusCode: 200,
  responseHeaders: {
    "content-type": "application/pdf",
    "content-length": "59163826",
  },
  screenshots: [],
  actionContent: [],
  actionResults: [],
  file: {
    name: "report.pdf",
    gcs_uri: "gs://fire-engine-handoff/pdf-handoff/0f1e2d3c-job.pdf",
    sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
    size_bytes: 59163826,
  },
  usedMobileProxy: true,
  timezone: "America/New_York",
};

describe("fireEngineFileSchema", () => {
  it("accepts an inline file", () => {
    expect(
      fireEngineFileSchema.safeParse({ name: "a.pdf", content: "JVBERi0=" })
        .success,
    ).toBe(true);
  });

  it("accepts a GCS handoff reference", () => {
    expect(fireEngineFileSchema.safeParse(handoffStatus.file).success).toBe(
      true,
    );
  });

  it("accepts a missing or null file", () => {
    expect(fireEngineFileSchema.safeParse(undefined).success).toBe(true);
    expect(fireEngineFileSchema.safeParse(null).success).toBe(true);
  });

  it("rejects a file carrying both or neither transport", () => {
    expect(
      fireEngineFileSchema.safeParse({
        name: "a.pdf",
        content: "JVBERi0=",
        gcs_uri: "gs://b/k.pdf",
      }).success,
    ).toBe(false);
    expect(fireEngineFileSchema.safeParse({ name: "a.pdf" }).success).toBe(
      false,
    );
  });
});

describe("fireEngineScrape response parsing", () => {
  it("accepts a finished job carrying a GCS handoff on the POST /scrape fast path", async () => {
    fetchFake.status = handoffStatus;
    const result = await fireEngineScrape(
      fakeMeta,
      fakeLogger,
      request,
      null,
      undefined,
      "http://fire-engine.test",
    );
    expect("file" in result && result.file).toMatchObject({
      gcs_uri: handoffStatus.file.gcs_uri,
      sha256: handoffStatus.file.sha256,
      size_bytes: handoffStatus.file.size_bytes,
    });
  });

  it("still accepts a finished job carrying an inline file", async () => {
    fetchFake.status = {
      ...handoffStatus,
      file: { name: "report.pdf", content: "JVBERi0=" },
    };
    const result = await fireEngineScrape(
      fakeMeta,
      fakeLogger,
      request,
      null,
      undefined,
      "http://fire-engine.test",
    );
    expect("file" in result && result.file).toMatchObject({
      content: "JVBERi0=",
    });
  });

  it("rejects a file that carries both transports as an unmatched response", async () => {
    fetchFake.status = {
      ...handoffStatus,
      file: { ...handoffStatus.file, content: "JVBERi0=" },
    };
    await expect(
      fireEngineScrape(
        fakeMeta,
        fakeLogger,
        request,
        null,
        undefined,
        "http://fire-engine.test",
      ),
    ).rejects.toThrow("not matched by any schema");
  });
});
