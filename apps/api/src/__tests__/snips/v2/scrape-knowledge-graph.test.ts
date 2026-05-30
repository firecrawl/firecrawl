import { concurrentIf, HAS_AI, TEST_PRODUCTION } from "../lib";
import {
  scrape,
  scrapeWithFailure,
  scrapeTimeout,
  idmux,
  Identity,
} from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-knowledge-graph",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describe("Knowledge graph format", () => {
  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "returns a graph of nodes and edges for a valid page",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [{ type: "knowledgeGraph" }],
        },
        identity,
      );

      expect(response.knowledgeGraph).toBeDefined();
      expect(Array.isArray(response.knowledgeGraph!.nodes)).toBe(true);
      expect(Array.isArray(response.knowledgeGraph!.edges)).toBe(true);
      expect(response.knowledgeGraph!.nodes.length).toBeGreaterThan(0);

      // Every node has the required shape
      for (const node of response.knowledgeGraph!.nodes) {
        expect(typeof node.id).toBe("string");
        expect(typeof node.label).toBe("string");
        expect(typeof node.type).toBe("string");
      }

      // Every edge references node ids that were actually emitted
      const nodeIds = new Set(response.knowledgeGraph!.nodes.map(n => n.id));
      for (const edge of response.knowledgeGraph!.edges) {
        expect(typeof edge.relation).toBe("string");
        expect(nodeIds.has(edge.source)).toBe(true);
        expect(nodeIds.has(edge.target)).toBe(true);
      }

      // knowledgeGraph alone should not leak markdown into the response
      expect(response.markdown).toBeUndefined();
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "returns both markdown and knowledgeGraph when both formats are requested",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown", { type: "knowledgeGraph" }],
        },
        identity,
      );

      expect(response.knowledgeGraph).toBeDefined();
      expect(response.knowledgeGraph!.nodes.length).toBeGreaterThan(0);
      expect(response.markdown).toBeDefined();
      expect(typeof response.markdown).toBe("string");
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "does not include knowledgeGraph field when the format is not requested",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown"],
        },
        identity,
      );

      expect(response.knowledgeGraph).toBeUndefined();
    },
    scrapeTimeout,
  );

  it(
    "rejects entityTypes lists longer than the maximum",
    async () => {
      const response = await scrapeWithFailure(
        {
          url: "https://firecrawl.dev",
          formats: [
            {
              type: "knowledgeGraph",
              entityTypes: Array.from({ length: 51 }, (_, i) => `Type${i}`),
            },
          ],
        } as any,
        identity,
      );

      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
    },
    scrapeTimeout,
  );
});
