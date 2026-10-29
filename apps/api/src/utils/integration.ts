import { z } from "zod";

enum IntegrationEnum {
  DIFY = "dify",
  ZAPIER = "zapier",
  PIPEDREAM = "pipedream",
  RAYCAST = "raycast",
  LANGCHAIN = "langchain",
  CREWAI = "crewai",
  LLAMAINDEX = "llamaindex",
  N8N = "n8n",
  CAMELAI = "camelai",
  MAKE = "make",
  FLOWISE = "flowise",
  METAGPT = "metagpt",
  RELEVANCEAI = "relevanceai",
  VIASOCKET = "viasocket",
  CLI = "cli",
  HERMES = "hermes",
  GSTACK = "gstack",
  PROMETHEUS = "prometheus",
  LOVABLE = "lovable",
}

export const integrationSchema = z
  .string()
  .refine(
    val =>
      (typeof val === "string" && val.startsWith("_")) ||
      Object.values(IntegrationEnum).includes(val as any),
    {
      message: `Invalid enum value. Expected ${Object.values(IntegrationEnum)
        .map(v => `'${v}'`)
        .join(" | ")}`,
    },
  );

/** The X-Integration header as an integration value, or undefined when it is missing or invalid. */
export function integrationFromHeader(req: {
  headers?: Record<string, string | string[] | undefined>;
}): string | undefined {
  const header = req.headers?.["x-integration"];
  const value =
    typeof header === "string" ? header.trim().toLowerCase() : undefined;
  return value && integrationSchema.safeParse(value).success
    ? value
    : undefined;
}

/**
 * The integration to attribute: a valid X-Integration header replaces a
 * missing or `cli` explicit value; any other explicit value wins.
 */
export function resolveIntegration<T>(
  explicit: T,
  req: { headers?: Record<string, string | string[] | undefined> },
): T | string {
  if (explicit != null && explicit !== "cli") return explicit;
  return integrationFromHeader(req) ?? explicit;
}
