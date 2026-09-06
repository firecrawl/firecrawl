import * as winston from "winston";
import { MapDocument } from "../controllers/v2/types";
import { MapFailedError } from "./error";
import { resolveUrl, UrlResolverHttpError } from "./url-resolver";

interface AvgrabResolvedPost {
  url: string;
  title: string;
  date: string;
  type: string;
  media: string[];
}

interface AvgrabResolveResponse {
  posts: AvgrabResolvedPost[];
}

export async function resolveViaAvgrab(
  url: string,
  limit: number,
  logger: winston.Logger,
  signal?: AbortSignal,
): Promise<MapDocument[] | null> {
  let data: AvgrabResolveResponse | null;
  try {
    data = (await resolveUrl(url, logger, {
      requestBody: { limit },
      signal,
    })) as AvgrabResolveResponse | null;
  } catch (error) {
    if (error instanceof UrlResolverHttpError) {
      throw new MapFailedError(error.message);
    }
    throw error;
  }

  if (data === null) return null;

  return data.posts.map(post => {
    const { url: _url, title: _title, ...meta } = post;
    return {
      url: post.url,
      title: post.title || undefined,
      description: JSON.stringify(meta),
    };
  });
}
