import { Agent, fetch } from "undici";
import * as winston from "winston";
import { config } from "../config";
import { MapDocument } from "../controllers/v2/types";
import { MapFailedError } from "./error";

const resolverAgent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 5 * 60 * 1000,
});

let cachedResolveRegex: RegExp | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

type UrlResolverResult = {
  links: MapDocument[];
  metadata?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseUrlResolverResponse(value: unknown): UrlResolverResult {
  if (!isRecord(value) || !Array.isArray(value.links)) {
    throw new Error("URL resolver service returned an invalid response");
  }

  const links = value.links.map((item, index): MapDocument => {
    if (!isRecord(item) || typeof item.url !== "string") {
      throw new Error(
        `URL resolver service returned an invalid link at index ${index}`,
      );
    }
    if (item.title != null && typeof item.title !== "string") {
      throw new Error(
        `URL resolver service returned an invalid link title at index ${index}`,
      );
    }
    if (item.description != null && typeof item.description !== "string") {
      throw new Error(
        `URL resolver service returned an invalid link description at index ${index}`,
      );
    }

    return {
      url: item.url,
      title: item.title as string | undefined,
      description: item.description as string | undefined,
    };
  });

  if (value.metadata != null && !isRecord(value.metadata)) {
    throw new Error("URL resolver service returned invalid metadata");
  }

  return {
    links,
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

export function mergeResolvedMetadata<T extends Record<string, unknown>>(
  resolvedMetadata: Record<string, unknown> | undefined,
  canonicalMetadata: T,
): T & Record<string, unknown> {
  return {
    ...(resolvedMetadata ?? {}),
    ...canonicalMetadata,
  };
}

async function getResolveRegex(): Promise<RegExp | null> {
  if (!config.AVGRAB_SERVICE_URL) return null;

  if (cachedResolveRegex && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedResolveRegex;
  }

  const res = await fetch(`${config.AVGRAB_SERVICE_URL}/supported-urls`);
  if (!res.ok) {
    throw new Error("Failed to fetch URL resolver service capabilities");
  }

  const data = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!data || typeof data.resolve_regex !== "string") {
    throw new Error("URL resolver service returned an invalid URL pattern");
  }

  cachedResolveRegex = new RegExp(data.resolve_regex);
  cacheTimestamp = Date.now();
  return cachedResolveRegex;
}

export async function supportsUrlResolver(url: string): Promise<boolean> {
  if (!config.AVGRAB_SERVICE_URL) return false;

  try {
    const regex = await getResolveRegex();
    return regex !== null && regex.test(url);
  } catch {
    return false;
  }
}

export async function resolveUrl(
  url: string,
  limit: number,
  logger: winston.Logger,
): Promise<UrlResolverResult | null> {
  if (!config.AVGRAB_SERVICE_URL) return null;
  if (!(await supportsUrlResolver(url))) return null;

  logger.info("URL matches resolver pattern, delegating to resolver service", {
    url,
  });

  const response = await fetch(`${config.AVGRAB_SERVICE_URL}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, limit }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
    dispatcher: resolverAgent,
  });

  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => ({ detail: "Unknown error" }))) as Record<string, unknown>;
    const detail =
      typeof body.detail === "string" ? body.detail : "Unknown error";
    logger.error("URL resolver service failed", {
      url,
      status: response.status,
      detail,
    });
    throw new MapFailedError(detail);
  }

  return parseUrlResolverResponse(await response.json());
}
