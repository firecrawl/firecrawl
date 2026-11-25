import type { MockedFunction } from "vitest";
import { performRedactPII } from "./redactPII";
import { redactText } from "../../../lib/fire-privacy-client";
import { UsOnlyUnavailableError } from "../error";

vi.mock("../../../lib/fire-privacy-client", () => ({
  redactText: vi.fn(),
}));

const mockedRedactText = redactText as MockedFunction<typeof redactText>;

describe("performRedactPII", () => {
  const baseMeta = () =>
    ({
      url: "https://example.com",
      options: {
        formats: [{ type: "markdown" }],
        redactPII: {
          mode: "accurate",
          replaceStyle: "tag",
        },
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      redactPII: {},
    }) as any;
  const baseDocument = (overrides: Record<string, unknown> = {}) =>
    ({
      metadata: {},
      ...overrides,
    }) as any;

  beforeEach(() => {
    mockedRedactText.mockReset();
  });

  it("replaces markdown with redacted markdown", async () => {
    mockedRedactText.mockResolvedValue({
      status: "ok",
      redactedMarkdown: "Hello <PERSON>",
      spans: [],
      counts: {},
      chunks: 1,
    });

    const document = await performRedactPII(
      baseMeta(),
      baseDocument({
        markdown: "Hello Alice",
      }),
    );

    expect(document.markdown).toBe("Hello <PERSON>");
  });

  it("runs when redactPII is enabled with markdown output", async () => {
    mockedRedactText.mockResolvedValue({
      status: "ok",
      redactedMarkdown: "Hello <PERSON>",
      spans: [],
      counts: {},
      chunks: 1,
    });

    const meta = baseMeta();
    meta.options.formats = [{ type: "markdown" }];

    const document = await performRedactPII(
      meta,
      baseDocument({
        markdown: "Hello Alice",
      }),
    );

    expect(mockedRedactText).toHaveBeenCalledTimes(1);
    expect(document.markdown).toBe("Hello <PERSON>");
  });

  it("keeps markdown as an empty string when redaction cannot produce safe output", async () => {
    mockedRedactText.mockResolvedValue({
      status: "failed",
      reason: "error",
      redactedMarkdown: null,
      spans: [],
      counts: {},
      chunks: 1,
    });

    const document = await performRedactPII(
      baseMeta(),
      baseDocument({
        markdown: "Hello Alice",
      }),
    );

    expect(document.markdown).toBe("");
  });

  it("keeps downstream markdown consumers safe when source markdown is missing", async () => {
    const meta = baseMeta();
    const document = await performRedactPII(meta, baseDocument());

    expect(mockedRedactText).not.toHaveBeenCalled();
    expect(document.markdown).toBe("");
    expect(meta.redactPII.current).toEqual({
      status: "failed",
      reason: "no_markdown",
      chunks: 0,
      spans: 0,
    });
  });

  it("records a content-free outcome on meta", async () => {
    mockedRedactText.mockResolvedValue({
      status: "skipped",
      reason: "upstream_skipped",
      redactedMarkdown: "Hello <PERSON>",
      spans: [
        {
          start: 6,
          end: 11,
          kind: "PERSON",
          entity: "PERSON",
          source: "model",
        },
      ],
      counts: { PERSON: 1 },
      chunks: 2,
    });
    const meta = baseMeta();

    await performRedactPII(meta, baseDocument({ markdown: "Hello Alice" }));

    expect(meta.redactPII.current).toEqual({
      status: "skipped",
      reason: "upstream_skipped",
      chunks: 2,
      spans: 1,
    });
  });

  it("records nothing when redactPII was not requested", async () => {
    const meta = baseMeta();
    meta.options.redactPII = undefined;

    await performRedactPII(meta, baseDocument({ markdown: "Hello Alice" }));

    expect(meta.redactPII.current).toBeUndefined();
  });

  it("pins redaction to US capacity only for a US-only team", async () => {
    mockedRedactText.mockResolvedValue({
      status: "ok",
      redactedMarkdown: "Hello <PERSON>",
      spans: [],
      counts: {},
      chunks: 1,
    });

    const unpinned = baseMeta();
    unpinned.internalOptions = { teamFlags: {} };
    await performRedactPII(unpinned, baseDocument({ markdown: "Hello Alice" }));

    const pinned = baseMeta();
    pinned.internalOptions = { teamFlags: { usOnly: true } };
    await performRedactPII(pinned, baseDocument({ markdown: "Hello Alice" }));

    expect(mockedRedactText.mock.calls[0][0].usOnly).toBe(false);
    expect(mockedRedactText.mock.calls[1][0].usOnly).toBe(true);
  });

  it("fails the scrape instead of returning unredacted markdown when US capacity refuses", async () => {
    mockedRedactText.mockRejectedValue(
      new UsOnlyUnavailableError("no US capacity"),
    );
    const meta = baseMeta();
    meta.internalOptions = { teamFlags: { usOnly: true } };

    await expect(
      performRedactPII(meta, baseDocument({ markdown: "Hello Alice" })),
    ).rejects.toBeInstanceOf(UsOnlyUnavailableError);
  });
});
