import { executeTransformers } from ".";
import { htmlTransform } from "../lib/removeUnwantedElements";
import { extractMetadata } from "../lib/extractMetadata";
import { sendDocumentToIndex } from "../engines/index/index";

vi.mock("../../../services/index", () => ({
  useIndex: true,
  useSearchIndex: false,
}));
vi.mock("../../../config", () => ({ config: {} }));
vi.mock("../../../services/indexing/indexer-queue", () => ({
  indexerQueue: {},
}));
vi.mock("../../../lib/html-to-markdown", () => ({ parseMarkdown: vi.fn() }));
vi.mock("../lib/removeUnwantedElements", () => ({
  htmlTransform: vi.fn(async html => html),
}));
vi.mock("../lib/extractLinks", () => ({ extractLinks: vi.fn() }));
vi.mock("../lib/extractLinksFromMarkdown", () => ({
  isMarkdownContentType: () => false,
}));
vi.mock("../lib/extractImages", () => ({ extractImages: vi.fn() }));
vi.mock("../lib/extractMetadata", () => ({
  extractMetadata: vi.fn(async () => ({ title: "Page" })),
}));
vi.mock("../engines/index/index", () => ({
  sendDocumentToIndex: vi.fn(async (_, document) => document),
}));
vi.mock("./llmExtract", () => ({
  performLLMExtract: vi.fn(async (_, document) => document),
  performSummary: vi.fn(async (_, document) => document),
  performCleanContent: vi.fn(async (_, document) => document),
}));
vi.mock("./deterministicJson", () => ({
  performDeterministicJson: vi.fn(async (_, document) => document),
}));
vi.mock("./query", () => ({
  performQuery: vi.fn(async (_, document) => document),
}));
vi.mock("./removeBase64Images", () => ({
  removeBase64Images: vi.fn(async (_, document) => document),
}));
vi.mock("./agent", () => ({
  performAgent: vi.fn(async (_, document) => document),
}));
vi.mock("./performAttributes", () => ({
  performAttributes: vi.fn(async (_, document) => document),
}));
vi.mock("./diff", () => ({
  deriveDiff: vi.fn(async (_, document) => document),
}));
vi.mock("./audio", () => ({
  fetchAudio: vi.fn(async (_, document) => document),
}));
vi.mock("./product", () => ({
  fetchProduct: vi.fn(async (_, document) => document),
}));
vi.mock("./menu", () => ({
  fetchMenu: vi.fn(async (_, document) => document),
}));
vi.mock("./video", () => ({
  fetchVideo: vi.fn(async (_, document) => document),
}));
vi.mock("./redactPII", () => ({
  performRedactPII: vi.fn(async (_, document) => document),
}));
vi.mock("../../../lib/branding/transformer", () => ({
  brandingTransformer: vi.fn(async (_, document) => document),
}));
vi.mock("./sendToSearchIndex", () => ({
  sendDocumentToSearchIndex: vi.fn(async (_, document) => document),
}));

function meta(teamId: string) {
  const logger = { debug: vi.fn(), warn: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return {
    id: "sitemap;test",
    url: "https://example.com/sitemap.xml",
    internalOptions: { teamId },
    options: { formats: [{ type: "rawHtml" }] },
    logger,
  } as any;
}

beforeEach(() => vi.clearAllMocks());

it.each([200, 503])(
  "keeps XML and HTTP metadata without HTML parsing for sitemap status %i",
  async statusCode => {
    const rawHtml =
      "<urlset><url><loc>https://example.com/page?a=1&amp;b=2</loc></url></urlset>";
    const document = {
      rawHtml,
      metadata: { statusCode, sourceURL: "https://example.com/sitemap.xml" },
    };
    const result = await executeTransformers(meta("sitemap"), document as any);
    expect(result.rawHtml).toBe(rawHtml);
    expect(result.metadata).toMatchObject({
      ...document.metadata,
      scrapeId: "sitemap;test",
    });
    expect(htmlTransform).not.toHaveBeenCalled();
    expect(extractMetadata).not.toHaveBeenCalled();
    expect(sendDocumentToIndex).toHaveBeenCalledOnce();
  },
);

it("still derives metadata for an ordinary rawHtml scrape", async () => {
  const result = await executeTransformers(meta("customer-team"), {
    rawHtml: "<html><head><title>Page</title></head><body>Hello</body></html>",
    metadata: { statusCode: 200 },
  } as any);
  expect(htmlTransform).toHaveBeenCalledOnce();
  expect(extractMetadata).toHaveBeenCalledOnce();
  expect(result.metadata.title).toBe("Page");
});
