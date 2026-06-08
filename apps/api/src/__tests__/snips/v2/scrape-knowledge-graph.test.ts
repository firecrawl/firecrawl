import { concurrentIf, HAS_AI, HAS_SEARCH, TEST_PRODUCTION } from "../lib";
import {
  scrape,
  scrapeWithFailure,
  scrapeTimeout,
  search,
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
      expect(Array.isArray(response.knowledgeGraph!.nodes)).toBe(true);
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

  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "returns a well-formed graph (no dangling edges) for a content-thin page",
    async () => {
      const response = await scrape(
        {
          url: "https://example.com",
          formats: [{ type: "knowledgeGraph" }],
        },
        identity,
      );

      expect(response.knowledgeGraph).toBeDefined();
      expect(Array.isArray(response.knowledgeGraph!.nodes)).toBe(true);
      expect(Array.isArray(response.knowledgeGraph!.edges)).toBe(true);

      // Pruning invariant must hold even on sparse content: every edge endpoint
      // resolves to an emitted node.
      const nodeIds = new Set(response.knowledgeGraph!.nodes.map(n => n.id));
      for (const edge of response.knowledgeGraph!.edges) {
        expect(nodeIds.has(edge.source)).toBe(true);
        expect(nodeIds.has(edge.target)).toBe(true);
      }
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "constrains node types to the entityTypes allow-list",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [
            {
              type: "knowledgeGraph",
              entityTypes: ["Product", "Organization"],
            },
          ],
        },
        identity,
      );

      expect(response.knowledgeGraph).toBeDefined();
      // Enforcement is deterministic regardless of how many entities the LLM
      // emits: every returned node type must be within the allow-list.
      const allowed = new Set(["product", "organization"]);
      for (const node of response.knowledgeGraph!.nodes) {
        expect(allowed.has(node.type.trim().toLowerCase())).toBe(true);
      }
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "returns an empty graph with a warning when entityTypes match nothing",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [
            {
              type: "knowledgeGraph",
              entityTypes: ["NonexistentEntityType9999"],
            },
          ],
        },
        identity,
      );

      expect(response.knowledgeGraph).toBeDefined();
      expect(response.knowledgeGraph!.nodes).toHaveLength(0);
      expect(response.knowledgeGraph!.edges).toHaveLength(0);
      expect(response.warning).toBeDefined();
      expect(response.warning).toContain("no entities");
    },
    scrapeTimeout,
  );

  concurrentIf((TEST_PRODUCTION || HAS_SEARCH) && HAS_AI)(
    "attaches a knowledgeGraph to scraped search results",
    async () => {
      const res = await search(
        {
          query: "Ada Lovelace",
          limit: 2,
          scrapeOptions: { formats: [{ type: "knowledgeGraph" }] },
        },
        identity,
      );

      expect(res.web).toBeDefined();
      expect(res.web!.length).toBeGreaterThan(0);

      // Any per-result graph present must be well-formed (no dangling edges).
      // Assert the invariant on whatever is returned rather than a strict count,
      // which would flake on non-deterministic LLM extraction.
      for (const result of res.web!) {
        const kg = (result as any).knowledgeGraph;
        if (!kg) continue;
        const nodeIds = new Set(kg.nodes.map((n: any) => n.id));
        for (const edge of kg.edges) {
          expect(nodeIds.has(edge.source)).toBe(true);
          expect(nodeIds.has(edge.target)).toBe(true);
        }
      }

      // A merged, deduped top-level graph is present and well-formed.
      const merged = (res as any).knowledgeGraph;
      expect(merged).toBeDefined();
      const mergedIds = merged.nodes.map((n: any) => n.id);
      expect(new Set(mergedIds).size).toBe(mergedIds.length); // unique ids
      const mergedIdSet = new Set(mergedIds);
      for (const edge of merged.edges) {
        expect(mergedIdSet.has(edge.source)).toBe(true);
        expect(mergedIdSet.has(edge.target)).toBe(true);
      }
    },
    60000 + scrapeTimeout,
  );
});
