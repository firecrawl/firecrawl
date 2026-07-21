import { Agent, fetch } from "undici";
import { config } from "../config";
import { MapDocument } from "../controllers/v2/types";
import { MapFailedError } from "./error";
import * as winston from "winston";

const avgrabAgent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 5 * 60 * 1000,
});

let cachedResolveRegex: RegExp | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getResolveRegex(): Promise<RegExp | null> {
  if (!config.AVGRAB_SERVICE_URL) return null;

  if (cachedResolveRegex && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedResolveRegex;
  }

  const res = await fetch(`${config.AVGRAB_SERVICE_URL}/supported-urls`);
  if (!res.ok) {
    throw new Error(
      "Failed to fetch supported URL patterns from avgrab service",
    );
  }

  const data = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!data || typeof data.resolve_regex !== "string") {
    throw new Error("avgrab service returned invalid resolve URL pattern");
  }

  cachedResolveRegex = new RegExp(data.resolve_regex as string);
  cacheTimestamp = Date.now();
  return cachedResolveRegex;
}

async function matchesResolveRegex(url: string): Promise<boolean> {
  if (!config.AVGRAB_SERVICE_URL) return false;

  try {
    const regex = await getResolveRegex();
    return regex !== null && regex.test(url);
  } catch {
    return false;
  }
}

interface AvgrabResolvedPost {
  url: string;
  title: string;
  date: string;
  type: string;
  media: string[];
}

interface AvgrabResolveResponse {
  username: string;
  posts: AvgrabResolvedPost[];
}

export async function resolveViaAvgrab(
  url: string,
  limit: number,
  logger: winston.Logger,
): Promise<MapDocument[] | null> {
  if (!config.AVGRAB_SERVICE_URL) return null;

  const matches = await matchesResolveRegex(url);
  if (!matches) return null;

  logger.info("URL matches avgrab resolve pattern, delegating to avgrab", {
    url,
  });

  const response = await fetch(`${config.AVGRAB_SERVICE_URL}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, limit }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
    dispatcher: avgrabAgent,
  });

  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => ({ detail: "Unknown error" }))) as Record<string, unknown>;
    const detail =
      typeof body.detail === "string" ? body.detail : "Unknown error";
    logger.error("avgrab resolve failed", {
      url,
      status: response.status,
      detail,
    });
    throw new MapFailedError(detail);
  }

  const data = (await response.json()) as AvgrabResolveResponse;

  return data.posts.map(post => {
    const { url: _url, title: _title, ...meta } = post;
    return {
      url: post.url,
      title: post.title || undefined,
      description: JSON.stringify(meta),
    };
  });
}
