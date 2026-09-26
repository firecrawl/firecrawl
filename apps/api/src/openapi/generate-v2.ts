import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  agentRequestSchema,
  batchScrapeRequestSchema,
  crawlRequestSchema,
  extractRequestSchema,
  jobIdParamsSchema,
  mapRequestSchema,
  scrapeRequestSchema,
  searchRequestSchema,
} from "../controllers/v2/types";
import { integrationSchema } from "../utils/integration";

type OpenAPIV3_1 = {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers: { url: string }[];
  tags?: { name: string; description?: string }[];
  paths: Record<string, any>;
  components: {
    securitySchemes?: Record<string, any>;
    schemas: Record<string, any>;
  };
};

function schemaRef(typeName: string) {
  return { $ref: `#/components/schemas/${typeName}` };
}

function zodToJsonSchema(
  schema: z.ZodTypeAny,
  io: "input" | "output" = "output",
) {
  // Zod v4 emits JSON Schema 2020-12, so we publish OpenAPI 3.1.0.
  // We keep $defs intact for recursive/union schemas.
  const jsonSchema = z.toJSONSchema(schema, {
    io,
    // v2 schemas use preprocess/transform heavily (URL normalization, etc).
    // Those can't be represented in JSON Schema, so we fall back to permissive
    // JSON Schema for the affected parts instead of throwing.
    unrepresentable: "any",
  });
  // OpenAPI component schemas don't need the $schema field.
  // Keeping it doesn't usually break anything, but removing reduces noise.
  const { $schema: _ignored, ...rest } = jsonSchema as any;
  return rest;
}

// Remove internal __ prefixed properties from JSON schema (recursive)
function stripInternalProps(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(stripInternalProps);

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      // Filter out __ prefixed properties
      const filtered: any = {};
      for (const [propName, propValue] of Object.entries(value)) {
        if (!propName.startsWith("__")) {
          filtered[propName] = stripInternalProps(propValue);
        }
      }
      result[key] = filtered;
    } else if (key === "$defs" && typeof value === "object" && value !== null) {
      // Process $defs recursively to strip __ props from nested schemas
      const filtered: any = {};
      for (const [defName, defValue] of Object.entries(value)) {
        filtered[defName] = stripInternalProps(defValue);
      }
      result[key] = filtered;
    } else if (
      key === "default" &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      // Strip __ prefixed keys from default values
      const filtered: any = {};
      for (const [propName, propValue] of Object.entries(value)) {
        if (!propName.startsWith("__")) {
          filtered[propName] = propValue;
        }
      }
      result[key] = filtered;
    } else if (key === "required" && Array.isArray(value)) {
      // Filter out __ prefixed required fields
      result[key] = value.filter((name: string) => !name.startsWith("__"));
    } else {
      result[key] = stripInternalProps(value);
    }
  }
  return result;
}

function zodObjectToParameters(
  objSchema: z.ZodTypeAny,
  location: "path" | "query",
) {
  const json = zodToJsonSchema(objSchema, "input");
  const props = (json as any)?.properties ?? {};
  const required = new Set<string>((json as any)?.required ?? []);

  return Object.entries<any>(props)
    .filter(([name]) => !name.startsWith("__"))
    .map(([name, schema]) => ({
      name,
      in: location,
      required: location === "path" ? true : required.has(name),
      schema,
    }));
}

async function main() {
  // This script is intended to be executed from apps/api (see package.json script).
  const apiRoot = path.resolve(process.cwd());

  const outPath = path.join(apiRoot, "openapi-v2.json");

  // Request body schemas come from the actual Zod validators used at runtime.
  // Response schemas reflect the actual shapes returned by controllers.
  const ErrorResponseSchema = z.object({
    success: z.literal(false),
    code: z.string().optional(),
    error: z.string(),
    details: z.any().optional(),
  });

  const IdUrlSuccessSchema = z.object({
    success: z.literal(true),
    id: z.string(),
    url: z.string(),
  });

  // Document schema (simplified for OpenAPI - key fields)
  const DocumentSchema = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    markdown: z.string().optional(),
    html: z.string().optional(),
    rawHtml: z.string().optional(),
    links: z.array(z.string()).optional(),
    images: z.array(z.string()).optional(),
    screenshot: z.string().optional(),
    extract: z.any().optional(),
    json: z.any().optional(),
    summary: z.string().optional(),
    warning: z.string().optional(),
    metadata: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      language: z.string().optional(),
      url: z.string().optional(),
      sourceURL: z.string().optional(),
      statusCode: z.number(),
      error: z.string().optional(),
    }),
  });

  // ScrapeResponse
  const ScrapeResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      warning: z.string().optional(),
      data: DocumentSchema,
      scrape_id: z.string().optional(),
    }),
  ]);

  // CrawlStatusResponse
  const CrawlStatusResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      status: z.enum(["scraping", "completed", "failed", "cancelled"]),
      completed: z.number(),
      total: z.number(),
      creditsUsed: z.number(),
      expiresAt: z.string(),
      next: z.string().optional(),
      data: z.array(DocumentSchema),
      warning: z.string().optional(),
    }),
  ]);

  // CrawlErrorsResponse
  const CrawlErrorsResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      errors: z.array(
        z.object({
          id: z.string(),
          timestamp: z.string().optional(),
          url: z.string(),
          code: z.string().optional(),
          error: z.string(),
        }),
      ),
      robotsBlocked: z.array(z.string()),
    }),
  ]);

  // OngoingCrawlsResponse
  const OngoingCrawlsResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      crawls: z.array(
        z.object({
          id: z.string(),
          teamId: z.string(),
          url: z.string(),
          created_at: z.string(),
          options: z.any(),
        }),
      ),
    }),
  ]);

  // MapResponse
  const MapResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      links: z
        .array(
          z.object({
            url: z.string(),
            title: z.string().optional(),
            description: z.string().optional(),
          }),
        )
        .optional(),
      warning: z.string().optional(),
    }),
  ]);

  // SearchResponse
  const SearchResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      warning: z.string().optional(),
      data: z.array(DocumentSchema),
      creditsUsed: z.number(),
    }),
  ]);

  // ExtractResponse
  const ExtractResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      error: z.string().optional(),
      data: z.any().optional(),
      scrape_id: z.string().optional(),
      id: z.string().optional(),
      warning: z.string().optional(),
      urlTrace: z
        .array(
          z.object({
            url: z.string(),
            status: z.enum(["mapped", "scraped", "error"]),
            timing: z.object({
              discoveredAt: z.string(),
              scrapedAt: z.string().optional(),
              completedAt: z.string().optional(),
            }),
            error: z.string().optional(),
            warning: z.string().optional(),
          }),
        )
        .optional(),
      sources: z.record(z.string(), z.array(z.string())).optional(),
      tokensUsed: z.number().optional(),
      creditsUsed: z.number().optional(),
    }),
  ]);

  // CrawlParamsPreviewRequest
  const CrawlParamsPreviewRequestSchema = z.object({
    url: z.url(),
    prompt: z.string().max(10000),
  });

  // CrawlParamsPreviewResponse
  const CrawlParamsPreviewResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      data: z
        .object({
          url: z.string(),
          includePaths: z.array(z.string()).optional(),
          excludePaths: z.array(z.string()).optional(),
          maxDepth: z.number().optional(),
          maxDiscoveryDepth: z.number().optional(),
          crawlEntireDomain: z.boolean().optional(),
          allowExternalLinks: z.boolean().optional(),
          allowSubdomains: z.boolean().optional(),
          sitemap: z.enum(["skip", "include", "only"]).optional(),
          ignoreQueryParameters: z.boolean().optional(),
          deduplicateSimilarURLs: z.boolean().optional(),
          delay: z.number().optional(),
          limit: z.number().optional(),
        })
        .optional(),
    }),
  ]);

  // CreditUsageResponse
  const CreditUsageResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      data: z.object({
        remainingCredits: z.number(),
        planCredits: z.number(),
        billingPeriodStart: z.string().nullable(),
        billingPeriodEnd: z.string().nullable(),
      }),
    }),
  ]);

  // CreditUsageHistoricalResponse
  const CreditUsageHistoricalResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      periods: z.array(
        z.object({
          startDate: z.string().nullable(),
          endDate: z.string().nullable(),
          apiKey: z.string().optional(),
          creditsUsed: z.number(),
        }),
      ),
    }),
  ]);

  // TokenUsageResponse
  const TokenUsageResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      data: z.object({
        remainingTokens: z.number(),
        planTokens: z.number(),
        billingPeriodStart: z.string().nullable(),
        billingPeriodEnd: z.string().nullable(),
      }),
    }),
  ]);

  // TokenUsageHistoricalResponse
  const TokenUsageHistoricalResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      periods: z.array(
        z.object({
          startDate: z.string().nullable(),
          endDate: z.string().nullable(),
          apiKey: z.string().optional(),
          tokensUsed: z.number(),
        }),
      ),
    }),
  ]);

  // QueueStatusResponse
  const QueueStatusResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      jobsInQueue: z.number(),
      activeJobsInQueue: z.number(),
      waitingJobsInQueue: z.number(),
      maxConcurrency: z.number(),
      mostRecentSuccess: z.string().nullable(),
    }),
  ]);

  // ConcurrencyCheckResponse
  const ConcurrencyCheckResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      concurrency: z.number(),
      maxConcurrency: z.number(),
    }),
  ]);

  // BrowserCreateRequest
  const BrowserCreateRequestSchema = z.object({
    ttl: z.number().optional(),
    activityTtl: z.number().optional(),
    streamWebView: z.boolean().optional(),
    integration: integrationSchema.optional(),
    profile: z
      .object({
        name: z.string(),
        saveChanges: z.boolean().optional(),
      })
      .optional(),
  });

  // BrowserCreateResponse
  const BrowserCreateResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      id: z.string(),
      cdpUrl: z.string(),
      liveViewUrl: z.string(),
      interactiveLiveViewUrl: z.string(),
      expiresAt: z.string(),
    }),
  ]);

  // BrowserExecuteRequest
  const BrowserExecuteRequestSchema = z.object({
    code: z.string(),
    language: z.enum(["python", "node", "bash"]).optional(),
    timeout: z.number().optional(),
    origin: z.string().optional(),
  });

  // BrowserExecuteResponse
  const BrowserExecuteResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      stdout: z.string().optional(),
      result: z.string().optional(),
      stderr: z.string().optional(),
      exitCode: z.number().optional(),
      killed: z.boolean().optional(),
      error: z.string().optional(),
    }),
  ]);

  // BrowserDeleteResponse
  const BrowserDeleteResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      sessionDurationMs: z.number().optional(),
      creditsBilled: z.number().optional(),
    }),
  ]);

  // BrowserListResponse
  const BrowserListResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      sessions: z
        .array(
          z.object({
            id: z.string(),
            status: z.string(),
            cdpUrl: z.string(),
            liveViewUrl: z.string(),
            interactiveLiveViewUrl: z.string(),
            streamWebView: z.boolean(),
            createdAt: z.string(),
            lastActivity: z.string(),
          }),
        )
        .optional(),
    }),
  ]);

  // X402SearchResponse (uses same shape as SearchResponse plus scrapeIds)
  const X402SearchResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.literal(true),
      data: z.any(),
      scrapeIds: z
        .object({
          web: z.array(z.string()).optional(),
          news: z.array(z.string()).optional(),
          images: z.array(z.string()).optional(),
        })
        .optional(),
      creditsUsed: z.number(),
      id: z.string(),
    }),
  ]);

  // ExtractStatusResponse (different from ExtractResponse — returns status payload)
  // Note: success can be false for failed jobs (status: "failed") while still
  // returning a 200 with the status payload.
  const ExtractStatusResponseSchema = z.union([
    ErrorResponseSchema,
    z.object({
      success: z.boolean(),
      status: z.enum(["processing", "completed", "failed"]),
      data: z.any().optional(),
      expiresAt: z.string(),
      steps: z.any().optional(),
      llmUsage: z.any().optional(),
      sources: z.any().optional(),
      costTracking: z.any().optional(),
      sessionIds: z.array(z.string()).optional(),
      tokensUsed: z.number().optional(),
      creditsUsed: z.number().optional(),
      error: z.string().optional(),
    }),
  ]);

  const schemas: Record<string, any> = {
    // Requests (strip internal __ prefixed properties)
    ScrapeRequest: stripInternalProps(
      zodToJsonSchema(scrapeRequestSchema, "input"),
    ),
    BatchScrapeRequest: stripInternalProps(
      zodToJsonSchema(batchScrapeRequestSchema, "input"),
    ),
    CrawlRequest: stripInternalProps(
      zodToJsonSchema(crawlRequestSchema, "input"),
    ),
    MapRequest: stripInternalProps(zodToJsonSchema(mapRequestSchema, "input")),
    SearchRequest: stripInternalProps(
      zodToJsonSchema(searchRequestSchema, "input"),
    ),
    ExtractRequest: stripInternalProps(
      zodToJsonSchema(extractRequestSchema, "input"),
    ),
    AgentRequest: stripInternalProps(
      zodToJsonSchema(agentRequestSchema, "input"),
    ),

    // Common / lightweight responses (best-effort)
    ErrorResponse: zodToJsonSchema(ErrorResponseSchema, "output"),
    CrawlResponse: zodToJsonSchema(
      z.union([ErrorResponseSchema, IdUrlSuccessSchema]),
      "output",
    ),
    BatchScrapeResponse: zodToJsonSchema(
      z.union([
        ErrorResponseSchema,
        IdUrlSuccessSchema.extend({
          invalidURLs: z.array(z.string()).optional(),
        }),
      ]),
      "output",
    ),
    AgentResponse: zodToJsonSchema(
      z.union([
        ErrorResponseSchema,
        z.object({ success: z.boolean(), id: z.string() }),
      ]),
      "output",
    ),
    AgentStatusResponse: zodToJsonSchema(
      z.union([
        ErrorResponseSchema,
        z.object({
          success: z.boolean(),
          status: z.enum(["processing", "completed", "failed"]),
          error: z.string().optional(),
          data: z.any().optional(),
          expiresAt: z.string(),
          creditsUsed: z.number().optional(),
        }),
      ]),
      "output",
    ),
    AgentCancelResponse: zodToJsonSchema(
      z.union([ErrorResponseSchema, z.object({ success: z.boolean() })]),
      "output",
    ),

    ScrapeResponse: zodToJsonSchema(ScrapeResponseSchema, "output"),
    CrawlStatusResponse: zodToJsonSchema(CrawlStatusResponseSchema, "output"),
    CrawlErrorsResponse: zodToJsonSchema(CrawlErrorsResponseSchema, "output"),
    OngoingCrawlsResponse: zodToJsonSchema(
      OngoingCrawlsResponseSchema,
      "output",
    ),
    MapResponse: zodToJsonSchema(MapResponseSchema, "output"),
    SearchResponse: zodToJsonSchema(SearchResponseSchema, "output"),
    ExtractResponse: zodToJsonSchema(ExtractResponseSchema, "output"),
    ExtractStatusResponse: zodToJsonSchema(
      ExtractStatusResponseSchema,
      "output",
    ),

    // Crawl params preview
    CrawlParamsPreviewRequest: zodToJsonSchema(
      CrawlParamsPreviewRequestSchema,
      "input",
    ),
    CrawlParamsPreviewResponse: zodToJsonSchema(
      CrawlParamsPreviewResponseSchema,
      "output",
    ),

    // Team analytics
    CreditUsageResponse: zodToJsonSchema(CreditUsageResponseSchema, "output"),
    CreditUsageHistoricalResponse: zodToJsonSchema(
      CreditUsageHistoricalResponseSchema,
      "output",
    ),
    TokenUsageResponse: zodToJsonSchema(TokenUsageResponseSchema, "output"),
    TokenUsageHistoricalResponse: zodToJsonSchema(
      TokenUsageHistoricalResponseSchema,
      "output",
    ),
    QueueStatusResponse: zodToJsonSchema(QueueStatusResponseSchema, "output"),
    ConcurrencyCheckResponse: zodToJsonSchema(
      ConcurrencyCheckResponseSchema,
      "output",
    ),

    // Browser API
    BrowserCreateRequest: zodToJsonSchema(BrowserCreateRequestSchema, "input"),
    BrowserCreateResponse: zodToJsonSchema(
      BrowserCreateResponseSchema,
      "output",
    ),
    BrowserExecuteRequest: zodToJsonSchema(
      BrowserExecuteRequestSchema,
      "input",
    ),
    BrowserExecuteResponse: zodToJsonSchema(
      BrowserExecuteResponseSchema,
      "output",
    ),
    BrowserDeleteResponse: zodToJsonSchema(
      BrowserDeleteResponseSchema,
      "output",
    ),
    BrowserListResponse: zodToJsonSchema(BrowserListResponseSchema, "output"),

    // X402 Search
    X402SearchResponse: zodToJsonSchema(X402SearchResponseSchema, "output"),
  };

  const doc: OpenAPIV3_1 = {
    openapi: "3.1.0",
    info: {
      title: "Firecrawl API",
      version: "v2",
      description:
        "Autogenerated OpenAPI spec for the Firecrawl v2 API (derived from src/routes/v2.ts and src/controllers/v2/types.ts).",
    },
    servers: [{ url: "https://api.firecrawl.dev/v2" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API Key",
          description: "Provide your Firecrawl API key as a bearer token.",
        },
      },
      schemas,
    },
    paths: {
      "/scrape": {
        post: {
          tags: ["Scraping"],
          operationId: "Scrape",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: schemaRef("ScrapeRequest") },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": { schema: schemaRef("ScrapeResponse") },
              },
            },
          },
        },
      },
      "/scrape/{jobId}": {
        get: {
          tags: ["Scraping"],
          operationId: "Scrape Status",
          security: [{ bearerAuth: [] }],
          parameters: zodObjectToParameters(jobIdParamsSchema, "path"),
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": { schema: schemaRef("ScrapeResponse") },
              },
            },
          },
        },
      },
      "/batch/scrape": {
        post: {
          tags: ["Scraping"],
          operationId: "Batch Scrape",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: schemaRef("BatchScrapeRequest") },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("BatchScrapeResponse"),
                },
              },
            },
          },
        },
      },
      "/batch/scrape/{jobId}": {
        get: {
          tags: ["Scraping"],
          operationId: "Batch Scrape Status",
          security: [{ bearerAuth: [] }],
          parameters: zodObjectToParameters(jobIdParamsSchema, "path"),
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("CrawlStatusResponse"),
                },
              },
            },
          },
        },
        delete: {
          tags: ["Scraping"],
          operationId: "Batch Scrape Cancel",
          security: [{ bearerAuth: [] }],
          parameters: zodObjectToParameters(jobIdParamsSchema, "path"),
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("AgentCancelResponse"),
                },
              },
            },
          },
        },
      },
      "/batch/scrape/{jobId}/errors": {
        get: {
          tags: ["Scraping"],
          operationId: "Batch Scrape Errors",
          security: [{ bearerAuth: [] }],
          parameters: zodObjectToParameters(jobIdParamsSchema, "path"),
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("CrawlErrorsResponse"),
                },
              },
            },
          },
        },
      },
      "/search": {
        post: {
          tags: ["Search"],
          operationId: "Search",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: schemaRef("SearchRequest") },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": { schema: schemaRef("SearchResponse") },
              },
            },
          },
        },
      },
      "/map": {
        post: {
          tags: ["Mapping"],
          operationId: "Map",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: schemaRef("MapRequest") },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": { schema: schemaRef("MapResponse") },
              },
            },
          },
        },
      },
      "/crawl": {
        post: {
          tags: ["Crawling"],
          operationId: "Crawl",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: schemaRef("CrawlRequest") },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": { schema: schemaRef("CrawlResponse") },
              },
            },
          },
        },
      },
      "/crawl/{jobId}": {
        get: {
          tags: ["Crawling"],
          operationId: "Crawl Status",
          security: [{ bearerAuth: [] }],
          parameters: zodObjectToParameters(jobIdParamsSchema, "path"),
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("CrawlStatusResponse"),
                },
              },
            },
          },
        },
        delete: {
          tags: ["Crawling"],
          operationId: "Crawl Cancel",
          security: [{ bearerAuth: [] }],
          parameters: zodObjectToParameters(jobIdParamsSchema, "path"),
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("AgentCancelResponse"),
                },
              },
            },
          },
        },
      },
      "/crawl/{jobId}/errors": {
        get: {
          tags: ["Crawling"],
          operationId: "Crawl Errors",
          security: [{ bearerAuth: [] }],
          parameters: zodObjectToParameters(jobIdParamsSchema, "path"),
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("CrawlErrorsResponse"),
                },
              },
            },
          },
        },
      },
      "/crawl/ongoing": {
        get: {
          tags: ["Crawling"],
          operationId: "Crawl Ongoing",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("OngoingCrawlsResponse"),
                },
              },
            },
          },
        },
      },
      "/crawl/active": {
        get: {
          tags: ["Crawling"],
          operationId: "Crawl Active",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("OngoingCrawlsResponse"),
                },
              },
            },
          },
        },
      },
      "/extract": {
        post: {
          tags: ["Extract"],
          operationId: "Extract",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: schemaRef("ExtractRequest") },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": { schema: schemaRef("ExtractResponse") },
              },
            },
          },
        },
      },
      "/extract/{jobId}": {
        get: {
          tags: ["Extract"],
          operationId: "Extract Status",
          security: [{ bearerAuth: [] }],
          parameters: zodObjectToParameters(jobIdParamsSchema, "path"),
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("ExtractStatusResponse"),
                },
              },
            },
          },
        },
      },
      "/agent": {
        post: {
          tags: ["Agent"],
          operationId: "Agent",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: schemaRef("AgentRequest") },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": { schema: schemaRef("AgentResponse") },
              },
            },
          },
        },
      },
      "/agent/{jobId}": {
        get: {
          tags: ["Agent"],
          operationId: "Agent Status",
          security: [{ bearerAuth: [] }],
          parameters: zodObjectToParameters(jobIdParamsSchema, "path"),
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("AgentStatusResponse"),
                },
              },
            },
          },
        },
        delete: {
          tags: ["Agent"],
          operationId: "Agent Cancel",
          security: [{ bearerAuth: [] }],
          parameters: zodObjectToParameters(jobIdParamsSchema, "path"),
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("AgentCancelResponse"),
                },
              },
            },
          },
        },
      },
      "/crawl/params-preview": {
        post: {
          tags: ["Crawling"],
          operationId: "Crawl Params Preview",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: schemaRef("CrawlParamsPreviewRequest"),
              },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("CrawlParamsPreviewResponse"),
                },
              },
            },
          },
        },
      },
      "/team/credit-usage": {
        get: {
          tags: ["Team"],
          operationId: "Credit Usage",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("CreditUsageResponse"),
                },
              },
            },
          },
        },
      },
      "/team/credit-usage/historical": {
        get: {
          tags: ["Team"],
          operationId: "Credit Usage Historical",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "byApiKey",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["true", "false"] },
            },
          ],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("CreditUsageHistoricalResponse"),
                },
              },
            },
          },
        },
      },
      "/team/token-usage": {
        get: {
          tags: ["Team"],
          operationId: "Token Usage",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("TokenUsageResponse"),
                },
              },
            },
          },
        },
      },
      "/team/token-usage/historical": {
        get: {
          tags: ["Team"],
          operationId: "Token Usage Historical",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "byApiKey",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["true", "false"] },
            },
          ],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("TokenUsageHistoricalResponse"),
                },
              },
            },
          },
        },
      },
      "/team/queue-status": {
        get: {
          tags: ["Team"],
          operationId: "Queue Status",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("QueueStatusResponse"),
                },
              },
            },
          },
        },
      },
      "/concurrency-check": {
        get: {
          tags: ["Team"],
          operationId: "Concurrency Check",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("ConcurrencyCheckResponse"),
                },
              },
            },
          },
        },
      },
      "/browser": {
        post: {
          tags: ["Browser"],
          operationId: "Browser Create",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: schemaRef("BrowserCreateRequest"),
              },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("BrowserCreateResponse"),
                },
              },
            },
          },
        },
        get: {
          tags: ["Browser"],
          operationId: "Browser List",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["active", "destroyed"] },
            },
          ],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("BrowserListResponse"),
                },
              },
            },
          },
        },
      },
      "/browser/{sessionId}/execute": {
        post: {
          tags: ["Browser"],
          operationId: "Browser Execute",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: schemaRef("BrowserExecuteRequest"),
              },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("BrowserExecuteResponse"),
                },
              },
            },
          },
        },
      },
      "/browser/{sessionId}": {
        delete: {
          tags: ["Browser"],
          operationId: "Browser Delete",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: schemaRef("BrowserDeleteResponse"),
                },
              },
            },
          },
        },
      },
    },
  };

  // x402/search is conditionally mounted in the router (requires X402_PAY_TO_ADDRESS),
  // but we always document it so the spec is deterministic.
  doc.paths["/x402/search"] = {
    post: {
      tags: ["Search"],
      operationId: "X402 Search",
      description:
        "Search endpoint with micropayment via X402 protocol. Only available when X402 is enabled on the server.",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: schemaRef("SearchRequest") },
        },
      },
      responses: {
        "200": {
          description: "Successful response",
          content: {
            "application/json": {
              schema: schemaRef("X402SearchResponse"),
            },
          },
        },
      },
    },
  };

  await fs.writeFile(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
