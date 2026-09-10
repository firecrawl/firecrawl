import { z } from "zod";
import type { Logger } from "winston";
import {
  forwardToExchange,
  EXCHANGE_DISCOVER_TIMEOUT_MS,
} from "../lib/exchange-proxy";

const identifiers = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9._/-]+$/),
  )
  .min(1)
  .max(50);
export const alexandriaSourceSchema = z
  .strictObject({
    type: z.enum(["alexandria", "exchange-providers"]),
    mode: z.enum(["semantic", "browse"]).optional(),
    categories: identifiers.optional(),
    providers: identifiers.optional(),
    groups: identifiers.optional(),
    capabilities: identifiers.optional(),
    domains: z
      .array(
        z
          .string()
          .toLowerCase()
          .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
      )
      .min(1)
      .max(50)
      .optional(),
    level: z.enum(["categories", "providers", "groups", "tools"]).optional(),
    expand: z
      .array(z.enum(["options", "response", "examples"]))
      .max(3)
      .optional(),
    languages: z
      .array(z.enum(["javascript", "python", "curl"]))
      .min(1)
      .max(3)
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(1000).optional(),
  })
  .refine(
    source =>
      !source.expand?.length ||
      (source.level ??
        (source.type === "exchange-providers" ? "tools" : "providers")) ===
        "tools",
    "Expand is available at the tools level.",
  )
  .refine(
    source => !source.languages || source.expand?.includes("examples"),
    "Languages requires expand: examples.",
  );
export type AlexandriaSource = z.infer<typeof alexandriaSourceSchema>;
export type AlexandriaResponse = {
  status: "available" | "unavailable";
  level: string;
  mode: string;
  items: Record<string, unknown>[];
  total: number | null;
  nextCursor: string | null;
  error?: string;
};

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
function examplesFor(item: Record<string, any>, source: AlexandriaSource) {
  const options: Record<string, unknown> = {};
  const descriptors = Array.isArray(item.requestOptions)
    ? item.requestOptions
    : [];
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
  const json = JSON.stringify(request, null, 2);
  const snippets = {
    javascript: `const requestId = "<unique-request-id>";\nconst response = await fetch("https://api.firecrawl.dev/exchange/retrieve", {\n  method: "POST",\n  headers: {\n    "Authorization": "Bearer " + process.env.FIRECRAWL_API_KEY,\n    "Content-Type": "application/json",\n    "x-request-id": requestId\n  },\n  body: JSON.stringify(${json})\n});\nconst result = await response.json();\nif (!response.ok) throw new Error(result.error ?? "Request failed");`,
    python: `import os\nimport requests\n\nrequest_id = "<unique-request-id>"\nresponse = requests.post(\n  "https://api.firecrawl.dev/exchange/retrieve",\n  headers={\n    "Authorization": "Bearer " + os.environ["FIRECRAWL_API_KEY"],\n    "x-request-id": request_id\n  },\n  json=${python(request)},\n  timeout=120\n)\nresponse.raise_for_status()\nresult = response.json()`,
    curl: `curl https://api.firecrawl.dev/exchange/retrieve \\\n  -H "Authorization: Bearer $FIRECRAWL_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "x-request-id: <unique-request-id>" \\\n  --data '${json.replace(/'/g, "'\\''")}'`,
  };
  return Object.fromEntries(
    (source.languages ?? ["javascript", "python", "curl"]).map(language => [
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
  const { source } = input;
  const level =
    source.level ??
    (source.type === "exchange-providers" ? "tools" : "providers");
  const mode = source.mode ?? (input.query.trim() ? "semantic" : "browse");
  const params = new URLSearchParams({
    level,
    mode,
    limit: String(source.limit ?? input.limit),
  });
  if (input.query.trim()) params.set("q", input.query.trim());
  for (const name of [
    "categories",
    "providers",
    "domains",
    "groups",
    "capabilities",
    "expand",
  ] as const)
    if (source[name]?.length) params.set(name, source[name]!.join(","));
  if (source.cursor) params.set("cursor", source.cursor);
  try {
    const upstream = await forwardToExchange({
      teamId: input.teamId,
      hasExtendedCatalogAccess: input.hasExtendedCatalogAccess === true,
      method: "GET",
      path: `/v1/discover/catalogue?${params}`,
      requestId: input.requestId,
      timeoutMs: Math.min(
        input.timeoutMs ?? EXCHANGE_DISCOVER_TIMEOUT_MS,
        EXCHANGE_DISCOVER_TIMEOUT_MS,
      ),
    });
    if (upstream.status === 400) {
      const message =
        (upstream.body as { error?: string })?.error ??
        "Invalid Alexandria discovery request.";
      throw new AlexandriaRequestError(message);
    }
    const schema = z.object({
      level: z.string(),
      mode: z.string(),
      items: z.array(z.record(z.string(), z.unknown())),
      total: z.number().int().nonnegative(),
      nextCursor: z.string().nullable(),
    });
    const parsed = schema.safeParse(upstream.body);
    if (upstream.status < 200 || upstream.status >= 300 || !parsed.success)
      throw new Error("Catalogue unavailable");
    return {
      status: "available",
      ...parsed.data,
      items: parsed.data.items.map(item => {
        const { requestOptions: _requestOptions, next, ...rest } = item;
        const nextSource = next as Record<string, unknown> | undefined;
        const { query: nextQuery, ...sourceOptions } = nextSource ?? {};
        return {
          ...rest,
          ...(source.expand?.includes("examples")
            ? { examples: examplesFor(item, source) }
            : {}),
          ...(nextSource
            ? {
                next: {
                  ...(nextQuery ? { query: nextQuery } : {}),
                  sources: [
                    {
                      ...sourceOptions,
                      ...(source.languages
                        ? { languages: source.languages }
                        : {}),
                    },
                  ],
                },
              }
            : {}),
        };
      }),
    };
  } catch (error) {
    if (error instanceof AlexandriaRequestError) throw error;
    logger.warn("Alexandria discovery unavailable", { error });
    return {
      status: "unavailable",
      level,
      mode,
      items: [],
      total: null,
      nextCursor: null,
      error: "Alexandria discovery is unavailable. Retry later.",
    };
  }
}
export class AlexandriaRequestError extends Error {}
