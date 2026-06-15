import type { MockedFunction } from "vitest";
import { performRedactPII } from "./redactPII";
import { redactText } from "../../../lib/fire-privacy-client";

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
    const document = await performRedactPII(baseMeta(), baseDocument());

    expect(mockedRedactText).not.toHaveBeenCalled();
    expect(document.markdown).toBe("");
  });
});
