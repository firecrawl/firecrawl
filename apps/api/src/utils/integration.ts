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
