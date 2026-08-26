const gcsFake = vi.hoisted(() => ({
  meta: { size: "1024", generation: "123456789012345678" } as {
    size: string;
    generation?: string;
  },
  bytes: Buffer.alloc(1024, 7),
  reads: [] as Array<{ bucket: string; key: string; generation?: string }>,
  copies: [] as Array<{
    srcBucket: string;
    srcKey: string;
    generation?: string;
    destBucket: string;
    destKey: string;
  }>,
  failRead: false,
  reset() {
    this.meta = { size: "1024", generation: "123456789012345678" };
    this.bytes = Buffer.alloc(1024, 7);
    this.reads = [];
    this.copies = [];
    this.failRead = false;
  },
}));

vi.mock("../../../../../lib/gcs-jobs", async () => {
  const { Readable, PassThrough } = await import("node:stream");
  const makeFile = (
    bucket: string,
    key: string,
    opts?: { generation?: string },
  ) => ({
    _bucket: bucket,
    _key: key,
    getMetadata: async () => [gcsFake.meta],
    createReadStream: () => {
      gcsFake.reads.push({ bucket, key, generation: opts?.generation });
      if (gcsFake.failRead) {
        return new Readable({
          read() {
            this.destroy(new Error("stream fail"));
          },
        });
      }
      return Readable.from([gcsFake.bytes]);
    },
    copy: async (dest: { _bucket: string; _key: string }) => {
      gcsFake.copies.push({
        srcBucket: bucket,
        srcKey: key,
        generation: opts?.generation,
        destBucket: dest._bucket,
        destKey: dest._key,
      });
    },
    createWriteStream: () => {
      const p = new PassThrough();
      p.resume();
      return p;
    },
  });
  return {
    storage: {
      bucket: (bucket: string) => ({
        file: (key: string, opts?: { generation?: string }) =>
          makeFile(bucket, key, opts),
      }),
    },
  };
});

import {
  largePdfLimitBytes,
  rewritePdfInputForFirePdf,
} from "../fire-pdf/by-reference";
import { downloadFireEngineGcsFile } from "../../utils/downloadGcsFile";
import { config } from "../../../../../config";
import { stat, readFile as readFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function makeMeta() {
  const noopLogger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function child() {
      return noopLogger;
    }),
  };
  return {
    id: "scrape-id-handoff",
    logger: noopLogger,
    abort: {
      throwIfAborted: vi.fn(),
      asSignal: vi.fn(() => new AbortController().signal),
      scrapeTimeout: vi.fn(() => undefined),
    },
    internalOptions: { teamId: "team-x" },
  } as any;
}

describe("fire-engine GCS handoff (bucket allowlists)", () => {
  // The inbound allowlist is opt-in: configure it for these tests so the
  // rejection cases exercise the bucket comparison, not the unset guard.
  const ORIGINAL_BUCKET = config.FIRE_ENGINE_PDF_GCS_BUCKET;
  beforeAll(() => {
    (config as any).FIRE_ENGINE_PDF_GCS_BUCKET = "fire-engine-scrape-storage";
  });
  afterAll(() => {
    (config as any).FIRE_ENGINE_PDF_GCS_BUCKET = ORIGINAL_BUCKET;
  });

  it("refuses every reference when the allowlist is unconfigured", async () => {
    (config as any).FIRE_ENGINE_PDF_GCS_BUCKET = undefined;
    try {
      await expect(
        downloadFireEngineGcsFile(
          makeMeta().logger,
          { uri: "gs://fire-engine-scrape-storage/pdf-handoff/x.pdf" },
          "/tmp/never-written.pdf",
        ),
      ).resolves.toBeNull();
      await expect(
        rewritePdfInputForFirePdf(makeMeta(), {
          uri: "gs://fire-engine-scrape-storage/pdf-handoff/x.pdf",
          sha256: "ab".repeat(32),
          sizeBytes: 1024,
        }),
      ).resolves.toBeNull();
    } finally {
      (config as any).FIRE_ENGINE_PDF_GCS_BUCKET = "fire-engine-scrape-storage";
    }
  });

  it("rewrite refuses a source outside fire-engine's handoff bucket", async () => {
    // Never copies out of an arbitrary bucket named by response data; the
    // caller falls back to the streaming upload of the local temp file.
    await expect(
      rewritePdfInputForFirePdf(makeMeta(), {
        uri: "gs://attacker-bucket/inputs/evil.pdf",
        sha256: "ab".repeat(32),
        sizeBytes: 1024,
      }),
    ).resolves.toBeNull();
  });

  it("rewrite refuses a malformed uri", async () => {
    await expect(
      rewritePdfInputForFirePdf(makeMeta(), {
        uri: "https://storage.googleapis.com/not-a-gs-uri.pdf",
        sha256: "ab".repeat(32),
        sizeBytes: 1024,
      }),
    ).resolves.toBeNull();
  });

  it("download refuses references outside the handoff bucket", async () => {
    const logger = makeMeta().logger;
    await expect(
      downloadFireEngineGcsFile(
        logger,
        { uri: "gs://some-other-bucket/pdf-handoff/x.pdf" },
        "/tmp/never-written.pdf",
      ),
    ).resolves.toBeNull();
    await expect(
      downloadFireEngineGcsFile(
        logger,
        { uri: "not-a-uri" },
        "/tmp/never-written.pdf",
      ),
    ).resolves.toBeNull();
  });
});

describe("largePdfLimitBytes (team tiers)", () => {
  const ORIGINAL = {
    ids: config.PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS,
    def: config.PDF_BY_REFERENCE_MAX_BYTES_DEFAULT,
    priv: config.PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED,
  };
  afterEach(() => {
    (config as any).PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS = ORIGINAL.ids;
    (config as any).PDF_BY_REFERENCE_MAX_BYTES_DEFAULT = ORIGINAL.def;
    (config as any).PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED = ORIGINAL.priv;
  });

  function metaForTeam(teamId?: string) {
    return { internalOptions: { teamId } } as any;
  }

  it("returns the default cap (50MB) for unlisted teams", () => {
    (config as any).PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS = "team-a, team-b";
    expect(largePdfLimitBytes(metaForTeam("team-x"))).toBe(50 * 1024 * 1024);
    expect(largePdfLimitBytes(metaForTeam(undefined))).toBe(50 * 1024 * 1024);
  });

  it("returns the privileged cap (200MB) for allowlisted teams", () => {
    (config as any).PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS = "team-a, team-b";
    expect(largePdfLimitBytes(metaForTeam("team-a"))).toBe(200 * 1024 * 1024);
    expect(largePdfLimitBytes(metaForTeam("team-b"))).toBe(200 * 1024 * 1024);
  });

  it("clamps configured caps to the 256MB architectural ceiling", () => {
    (config as any).PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS = "team-a";
    (config as any).PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED = 999 * 1024 * 1024;
    expect(largePdfLimitBytes(metaForTeam("team-a"))).toBe(256 * 1024 * 1024);
  });
});

describe("fire-engine GCS handoff (positive paths, mocked storage)", () => {
  const ORIGINAL_BUCKET = config.FIRE_ENGINE_PDF_GCS_BUCKET;
  beforeAll(() => {
    (config as any).FIRE_ENGINE_PDF_GCS_BUCKET = "fire-engine-scrape-storage";
  });
  afterAll(() => {
    (config as any).FIRE_ENGINE_PDF_GCS_BUCKET = ORIGINAL_BUCKET;
  });
  beforeEach(() => gcsFake.reset());

  it("streams a within-bucket reference to disk with a generation-pinned read", async () => {
    const dest = path.join(tmpdir(), `handoff-test-${crypto.randomUUID()}.pdf`);
    const res = await downloadFireEngineGcsFile(
      makeMeta().logger,
      { uri: "gs://fire-engine-scrape-storage/pdf-handoff/x.pdf" },
      dest,
    );
    expect(res).toEqual({
      sizeBytes: 1024,
      generation: "123456789012345678",
    });
    expect((await stat(dest)).size).toBe(1024);
    expect(await readFileAsync(dest)).toEqual(gcsFake.bytes);
    // The read is pinned to the exact generation whose size was validated,
    // carried as the SDK's string form (int64-safe).
    expect(gcsFake.reads).toEqual([
      {
        bucket: "fire-engine-scrape-storage",
        key: "pdf-handoff/x.pdf",
        generation: "123456789012345678",
      },
    ]);
  });

  it("enforces the per-request size gate from metadata", async () => {
    gcsFake.meta.size = String(300 * 1024 * 1024);
    const res = await downloadFireEngineGcsFile(
      makeMeta().logger,
      { uri: "gs://fire-engine-scrape-storage/pdf-handoff/x.pdf" },
      path.join(tmpdir(), `handoff-test-${crypto.randomUUID()}.pdf`),
      undefined,
      50 * 1024 * 1024,
    );
    expect(res).toBeNull();
    expect(gcsFake.reads).toEqual([]);
  });

  it("removes the partial temp file when the stream fails", async () => {
    gcsFake.failRead = true;
    const dest = path.join(tmpdir(), `handoff-test-${crypto.randomUUID()}.pdf`);
    const res = await downloadFireEngineGcsFile(
      makeMeta().logger,
      { uri: "gs://fire-engine-scrape-storage/pdf-handoff/x.pdf" },
      dest,
    );
    expect(res).toBeNull();
    await expect(stat(dest)).rejects.toThrow();
  });

  it("rewrites into the fire-pdf input bucket with a generation-pinned copy", async () => {
    const meta = makeMeta();
    const res = await rewritePdfInputForFirePdf(meta, {
      uri: "gs://fire-engine-scrape-storage/pdf-handoff/x.pdf",
      sha256: "ab".repeat(32),
      sizeBytes: 1024,
      generation: "123456789012345678",
    });
    expect(res).toEqual({
      gcsUri: expect.stringMatching(
        /^gs:\/\/firecrawl-pdf-pipeline\/inputs\/[0-9a-f]{8}-scrape-id-handoff\.pdf$/,
      ),
      sha256: "ab".repeat(32),
      sizeBytes: 1024,
    });
    expect(gcsFake.copies).toHaveLength(1);
    expect(gcsFake.copies[0]).toMatchObject({
      srcBucket: "fire-engine-scrape-storage",
      srcKey: "pdf-handoff/x.pdf",
      generation: "123456789012345678",
      destBucket: "firecrawl-pdf-pipeline",
    });
    expect(gcsFake.copies[0].destKey).toMatch(
      /^inputs\/[0-9a-f]{8}-scrape-id-handoff\.pdf$/,
    );
  });
});
