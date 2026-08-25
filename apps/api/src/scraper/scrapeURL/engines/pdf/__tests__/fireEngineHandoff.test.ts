import { rewritePdfInputForFirePdf } from "../fire-pdf/by-reference";
import { downloadFireEngineGcsFile } from "../../utils/downloadGcsFile";

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
