import { z } from "zod";
import type { Logger } from "winston";
import { searchExchangeCatalog } from "./exchange-source";
import {
  forwardToExchange,
  EXCHANGE_DISCOVER_TIMEOUT_MS,
} from "../lib/exchange-proxy";

export const alexandriaSourceSchema = z.strictObject({
  type: z.enum(["alexandria", "exchange-providers"]),
});
export type AlexandriaSource = z.infer<typeof alexandriaSourceSchema>;
export type AlexandriaResponse = {
  status: "available" | "unavailable";
  level: "tools";
  mode: "semantic";
  items: Record<string, unknown>[];
  total: number | null;
  nextCursor: null;
  error?: string;
  warning?: string;
};

const contractSchema = z.object({
  provider: z.string(),
  capability: z.string(),
  label: z.string(),
  whenToUse: z.string(),
  creditsCost: z.number().int().nonnegative(),
  perRecord: z.boolean(),
  options: z.array(
    z.object({ name: z.string(), type: z.string() }).passthrough(),
  ),
  requiresOneOf: z.array(z.array(z.string())).optional(),
  returns: z
    .object({
      about: z.string(),
      key: z.string(),
      fields: z.array(
        z.object({ name: z.string(), type: z.string() }).passthrough(),
      ),
    })
    .passthrough(),
  example: z
    .object({
      recordedAt: z.string(),
      request: z.record(z.string(), z.unknown()),
      response: z.unknown(),
    })
    .optional(),
});

const python = (value: unknown, depth = 0): string => {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value))
    return `[${value.map(item => python(item, depth)).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([key, item]) => `${"  ".repeat(depth + 1)}${JSON.stringify(key)}: ${python(item, depth + 1)}`).join(",\n")}\n${"  ".repeat(depth)}}`;
  }
  return JSON.stringify(value);
};
function examplesFor(item: Record<string, any>) {
  const options: Record<string, unknown> = {};
  const descriptors = Array.isArray(item.options) ? item.options : [];
  const selected = descriptors.filter(
    (option: any) => option.required || option.default !== undefined,
  );
  for (const alternatives of item.requiresOneOf ?? []) {
    if (
      alternatives.some((name: string) =>
        selected.some((option: any) => option.name === name),
      )
    )
      continue;
    const alternative = descriptors.find(
      (option: any) => option.name === alternatives[0],
    );
    if (alternative) selected.push(alternative);
  }
  for (const option of selected.length ? selected : descriptors.slice(0, 3)) {
    options[option.name] =
      option.default ??
      option.oneOf?.[0] ??
      (option.type === "boolean"
        ? false
        : option.type === "integer" || option.type === "number"
          ? (option.min ?? 1)
          : option.type === "array" || option.type?.endsWith("[]")
            ? option.type === "number[]"
              ? [option.min ?? 1]
              : option.type === "object[]"
                ? [{}]
                : [`<${option.name}>`]
            : option.type === "object"
              ? {}
              : `<${option.name}>`);
  }
  const request = {
    provider: item.provider,
    capability: item.capability,
    options: item.example?.request ?? options,
  };
  const scrapeRequest = { exchange: request };
  const json = JSON.stringify(scrapeRequest, null, 2);
  const snippets = {
    javascript: `const requestId = "<unique-request-id>";\nconst response = await fetch("https://api.firecrawl.dev/v2/scrape", {\n  method: "POST",\n  headers: {\n    "Authorization": "Bearer " + process.env.FIRECRAWL_API_KEY,\n    "Content-Type": "application/json",\n    "x-request-id": requestId\n  },\n  body: JSON.stringify(${json})\n});\nconst result = await response.json();\nif (!response.ok) throw new Error(result.error ?? "Request failed");`,
    python: `import os\nimport requests\n\nrequest_id = "<unique-request-id>"\nresponse = requests.post(\n  "https://api.firecrawl.dev/v2/scrape",\n  headers={\n    "Authorization": "Bearer " + os.environ["FIRECRAWL_API_KEY"],\n    "x-request-id": request_id\n  },\n  json=${python(scrapeRequest)},\n  timeout=120\n)\nresponse.raise_for_status()\nresult = response.json()`,
    curl: `curl https://api.firecrawl.dev/v2/scrape \\\n  -H "Authorization: Bearer $FIRECRAWL_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "x-request-id: <unique-request-id>" \\\n  --data '${json.replace(/'/g, "'\\''")}'`,
  };
  return Object.fromEntries(
    (["javascript", "python", "curl"] as const).map(language => [
      language,
      snippets[language],
    ]),
  );
}

export async function searchAlexandria(
  input: {
    query: string;
    source: AlexandriaSource;
    limit: number;
    teamId: string;
    hasExtendedCatalogAccess?: boolean;
    requestId?: string;
    timeoutMs?: number;
  },
  logger: Logger,
): Promise<AlexandriaResponse> {
  if (!input.query.trim())
    throw new AlexandriaRequestError(
      "A query is required for Alexandria search. Use Find Tools for lookup.",
    );
  const deadline =
    Date.now() +
    Math.min(
      input.timeoutMs ?? EXCHANGE_DISCOVER_TIMEOUT_MS,
      EXCHANGE_DISCOVER_TIMEOUT_MS,
    );
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("Discovery deadline exceeded");
    return ms;
  };
  try {
    const hits = await searchExchangeCatalog(
      { ...input, timeoutMs: remaining() },
      logger,
    );
    if (hits === null) throw new Error("Semantic discovery unavailable");
    const items: Record<string, unknown>[] = new Array(hits.length);
    let position = 0;
    let failures = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, hits.length) }, async () => {
        while (position < hits.length) {
          const index = position++;
          const hit = hits[index];
          try {
            const cohort = hit.cohorts[0];
            const identifiers = [
              ...(cohort ? [cohort] : []),
              hit.provider,
              ...hit.capability.split("/"),
            ];
            if (
              identifiers.some(
                id => !id || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(id),
              )
            )
              throw new Error("Invalid discovery identifier");
            const upstream = await forwardToExchange({
              teamId: input.teamId,
              hasExtendedCatalogAccess: input.hasExtendedCatalogAccess === true,
              ...(cohort
                ? {
                    method: "GET" as const,
                    path: `/v1/discover/${identifiers.map(encodeURIComponent).join("/")}`,
                  }
                : {
                    method: "POST" as const,
                    path: "/v1/retrieve",
                    body: {
                      provider: "firecrawl-contextual-discovery",
                      capability: "discovery/context",
                      options: {
                        providers: [hit.provider],
                        capabilities: [hit.capability],
                        expand: ["options", "response", "examples"],
                      },
                    },
                  }),
              requestId: input.requestId,
              timeoutMs: remaining(),
            });
            let contractBody = upstream.body;
            if (!cohort) {
              const lookup = z
                .object({
                  success: z.literal(true),
                  creditsCost: z.literal(0),
                  data: z.object({
                    items: z.array(z.record(z.string(), z.unknown())).length(1),
                  }),
                })
                .parse(upstream.body);
              const tool = lookup.data.items[0];
              contractBody = {
                ...tool,
                label: tool.name,
                whenToUse: tool.description,
                returns: tool.response,
              };
            }
            const parsed = contractSchema.safeParse(contractBody);
            if (upstream.status !== 200 || !parsed.success)
              throw new Error("Tool contract unavailable");
            const contract = parsed.data;
            if (
              contract.provider !== hit.provider ||
              contract.capability !== hit.capability
            )
              throw new Error("Tool contract identity mismatch");
            items[index] = {
              id: `${hit.provider}/${hit.capability}`,
              provider: hit.provider,
              capability: hit.capability,
              name: contract.label,
              description: contract.whenToUse,
              concept: hit.concept,
              cohorts: hit.cohorts,
              similarity: hit.similarity,
              creditsCost: contract.creditsCost,
              perRecord: contract.perRecord,
              options: contract.options,
              ...(contract.requiresOneOf
                ? { requiresOneOf: contract.requiresOneOf }
                : {}),
              response: contract.returns,
              ...(contract.example ? { example: contract.example } : {}),
              examples: examplesFor(contract),
            };
          } catch (error) {
            failures++;
            logger.warn("Alexandria tool contract unavailable", {
              provider: hit.provider,
              capability: hit.capability,
              error,
            });
          }
        }
      }),
    );
    const availableItems = items.filter(Boolean);
    if (failures && !availableItems.length)
      throw new Error("Tool contract loading failed");
    return {
      status: "available",
      mode: "semantic",
      level: "tools",
      items: availableItems,
      total: availableItems.length,
      nextCursor: null,
      ...(failures
        ? {
            warning:
              "Some tool contracts could not be loaded. Showing available matches.",
          }
        : {}),
    };
  } catch (error) {
    logger.warn("Alexandria discovery unavailable", { error });
    return {
      status: "unavailable",
      level: "tools",
      mode: "semantic",
      items: [],
      total: null,
      nextCursor: null,
      error: "Alexandria discovery is unavailable. Retry later.",
    };
  }
}
export class AlexandriaRequestError extends Error {}
