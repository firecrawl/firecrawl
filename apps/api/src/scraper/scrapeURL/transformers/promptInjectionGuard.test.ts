import type { Mock } from "vitest";
import { performPromptInjectionGuard } from "./promptInjectionGuard";
import { checkForPromptInjection } from "../lib/promptInjectionGuard";
import { PromptInjectionDetectedError } from "../error";
import { CostTracking } from "../../../lib/cost-tracking";
import { MAX_JSON_EXTRACTION_MARKDOWN_CHARS } from "../lib/extractSmartScrape";

vi.mock("../lib/promptInjectionGuard", () => ({
  checkForPromptInjection: vi.fn(),
}));

const mockedGuard = checkForPromptInjection as Mock;

const meta = (checkPromptInjection: boolean) =>
  ({
    id: "test-scrape",
    url: "https://example.com",
    options: { formats: [{ type: "markdown" }], checkPromptInjection },
    internalOptions: {
      teamId: "test-team",
      zeroDataRetention: false,
      llmTelemetry: { functionId: "test-function", metadata: {} },
    },
    costTracking: new CostTracking(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) as any;

const document = (markdown: string) =>
  ({ markdown, metadata: {}, warning: "earlier warning" }) as any;

describe("performPromptInjectionGuard", () => {
  beforeEach(() => {
    mockedGuard.mockReset();
  });

  it("does nothing when the check was not requested", async () => {
    const doc = document("page");

    expect(await performPromptInjectionGuard(meta(false), doc)).toBe(doc);
    expect(mockedGuard).not.toHaveBeenCalled();
  });

  it("scans the page markdown with the scrape's ids", async () => {
    mockedGuard.mockResolvedValue(true);
    const doc = document("page");

    expect(await performPromptInjectionGuard(meta(true), doc)).toBe(doc);
    expect(mockedGuard).toHaveBeenCalledTimes(1);
    expect(mockedGuard.mock.calls[0][0]).toMatchObject({
      markdown: "page",
      metadata: {
        teamId: "test-team",
        functionId: "test-function",
        scrapeId: "test-scrape",
      },
      zeroDataRetention: false,
    });
  });

  it("blocks the scrape when the guard detects an injection", async () => {
    mockedGuard.mockRejectedValue(new PromptInjectionDetectedError());

    await expect(
      performPromptInjectionGuard(meta(true), document("page")),
    ).rejects.toBeInstanceOf(PromptInjectionDetectedError);
  });

  it("warns when the guard could not scan every chunk", async () => {
    mockedGuard.mockResolvedValue(false);

    const result = await performPromptInjectionGuard(
      meta(true),
      document("page"),
    );

    expect(result.warning).toMatch(
      /^The prompt injection check could not scan all of the page content.* earlier warning$/,
    );
  });

  it("skips markdown over the json extraction cap with the same warning", async () => {
    const result = await performPromptInjectionGuard(
      meta(true),
      document("x".repeat(MAX_JSON_EXTRACTION_MARKDOWN_CHARS + 1)),
    );

    expect(mockedGuard).not.toHaveBeenCalled();
    expect(result.warning).toMatch(
      /^The prompt injection check could not scan all of the page content/,
    );
  });
});
