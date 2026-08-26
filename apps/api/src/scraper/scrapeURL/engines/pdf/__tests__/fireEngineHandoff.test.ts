import {
  largePdfLimitBytes,
  rewritePdfInputForFirePdf,
} from "../fire-pdf/by-reference";
import { downloadFireEngineGcsFile } from "../../utils/downloadGcsFile";
import { config } from "../../../../../config";

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
