import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import type { EngineScrapeResult } from "..";
import type { Meta } from "../..";
import { config } from "../../../../config";
import { EngineError } from "../../error";
import { getRedisConnection } from "../../../../services/queue-service";
import { redlock } from "../../../../services/redlock";

const WIKIMEDIA_AUTH_URL = "https://auth.enterprise.wikimedia.com/v1/login";
const WIKIMEDIA_API_BASE = "https://api.enterprise.wikimedia.com/v2";

const REDIS_TOKEN_KEY = "wikipedia_enterprise:access_token";
const REDIS_AUTH_LOCK_KEY = "lock:wikipedia_enterprise:auth";

const wikimediaAuthResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

const wikimediaRedirectResponseSchema = z.object({
  query: z
    .object({
      redirects: z
        .array(z.object({ from: z.string(), to: z.string() }))
        .nullish(),
      normalized: z
        .array(z.object({ from: z.string(), to: z.string() }))
        .nullish(),
      pages: z
        .array(z.object({ title: z.string(), missing: z.boolean().nullish() }))
        .nullish(),
    })
    .nullish(),
});

const wikimediaArticleSchema = z.object({
  name: z.string(),
  abstract: z.string().nullish(),
  article_body: z
    .object({
      html: z.string().nullish(),
      wikitext: z.string().nullish(),
    })
    .nullish(),
  url: z.string().nullish(),
  in_language: z
    .object({
      identifier: z.string().nullish(),
      name: z.string().nullish(),
    })
    .nullish(),
  is_part_of: z
    .object({
      identifier: z.string().nullish(),
      name: z.string().nullish(),
    })
    .nullish(),
  date_modified: z.string().nullish(),
  categories: z
    .array(
      z.object({
        name: z.string().nullish(),
        url: z.string().nullish(),
      }),
    )
    .nullish(),
  has_parts: z.array(z.object({ name: z.string().nullish() })).nullish(),
  image: z
    .object({
      content_url: z.string().nullish(),
      width: z.number().nullish(),
      height: z.number().nullish(),
    })
    .nullish(),
});

const wikimediaArticlesResponseSchema = z.array(wikimediaArticleSchema);

const WIKI_PROJECTS = {
  "wikipedia.org": "wiki",
  "wiktionary.org": "wiktionary",
  "wikisource.org": "wikisource",
  "wikibooks.org": "wikibooks",
  "wikiquote.org": "wikiquote",
  "wikiversity.org": "wikiversity",
  "wikivoyage.org": "wikivoyage",
} satisfies Record<string, string>;

async function getAccessToken(logger: Meta["logger"]): Promise<string> {
  const redis = getRedisConnection();

  try {
    const cached = await redis.get(REDIS_TOKEN_KEY);
    if (cached) {
      return cached;
    }
  } catch (error: unknown) {
    logger.warn(
      "Failed to read Wikipedia token from Redis, will re-authenticate",
      { error },
    );
  }

  // Acquire a distributed lock so only one instance authenticates at a time.
  // Others wait and then read the token from Redis.
  return await redlock.using([REDIS_AUTH_LOCK_KEY], 10_000, async signal => {
    // Double-check: another instance may have authenticated while we waited for the lock
    try {
      const cached = await redis.get(REDIS_TOKEN_KEY);
      if (cached) {
        return cached;
      }
    } catch {
      // Redis read failed; fall through to re-authenticate.
    }

    const username = config.WIKIPEDIA_ENTERPRISE_USERNAME;
    const password = config.WIKIPEDIA_ENTERPRISE_PASSWORD;

    if (!username || !password) {
      throw new EngineError(
        "Wikipedia Enterprise API credentials are not configured (WIKIPEDIA_ENTERPRISE_USERNAME, WIKIPEDIA_ENTERPRISE_PASSWORD)",
      );
    }

    logger.info("Authenticating with Wikipedia Enterprise API");

    const response = await undiciFetch(WIKIMEDIA_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (signal.aborted) {
      throw (
        signal.error ??
        new EngineError("Wikipedia Enterprise authentication lock aborted")
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw new EngineError(
        `Wikipedia Enterprise authentication failed (${response.status}): ${body}`,
      );
    }

    const parsedAuth = wikimediaAuthResponseSchema.safeParse(
      await response.json(),
    );
    if (!parsedAuth.success) {
      throw new EngineError(
        `Wikipedia Enterprise authentication returned an unexpected payload: ${parsedAuth.error.message}`,
      );
    }
    const data = parsedAuth.data;

    const ttlSeconds = Math.max(data.expires_in - 300, 60);

    try {
      await redis.set(REDIS_TOKEN_KEY, data.access_token, "EX", ttlSeconds);
    } catch (error: unknown) {
      logger.warn("Failed to cache Wikipedia token in Redis", { error });
    }

    return data.access_token;
  });
}

function clearCachedToken(logger: Meta["logger"]): void {
  try {
    getRedisConnection()
      .del(REDIS_TOKEN_KEY)
      .catch((error: unknown) => {
        logger.warn("Failed to clear Wikipedia token from Redis", { error });
      });
  } catch {
    logger.warn("Failed to clear Wikipedia token from Redis");
  }
}

// Maps Wikimedia project hostnames to project identifiers used by the Enterprise API.
// e.g. "en.wikipedia.org" -> { lang: "en", project: "wikipedia" }
export function parseWikimediaUrl(url: string): {
  articleName: string;
  lang: string;
  projectIdentifier: string;
} | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const hostname = parsed.hostname;

  for (const [domain, projectSuffix] of Object.entries(WIKI_PROJECTS)) {
    const regex = new RegExp(
      `^([a-z]{2,3})\\.${domain.replace(".", String.raw`\.`)}$`,
    );
    const match = hostname.match(regex);
    if (match) {
      const lang = match[1];
      const pathMatch = parsed.pathname.match(/^\/wiki\/(.+)$/);
      if (!pathMatch) {
        return null;
      }

      return {
        articleName: decodeURIComponent(pathMatch[1]).replaceAll(" ", "_"),
        lang,
        projectIdentifier: `${lang}${projectSuffix}`,
      };
    }
  }

  return null;
}

/**
 * Resolves redirects using Wikipedia's free MediaWiki API.
 * e.g. "Brasil" -> "Brazil", "UK" -> "United Kingdom"
 */
async function resolveRedirect(
  articleName: string,
  lang: string,
  domain: string,
  logger: Meta["logger"],
): Promise<string> {
  const apiUrl =
    `https://${lang}.${domain}/w/api.php?` +
    new URLSearchParams({
      action: "query",
      titles: articleName,
      redirects: "1",
      format: "json",
      formatversion: "2",
    }).toString();

  try {
    const response = await undiciFetch(apiUrl, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return articleName;
    }

    const data = wikimediaRedirectResponseSchema.parse(await response.json());

    const redirects = data.query?.redirects;
    const lastRedirect = redirects?.at(-1);
    if (lastRedirect) {
      const resolved = lastRedirect.to;
      logger.info("Resolved Wikipedia redirect", {
        from: articleName,
        to: resolved,
      });
      return resolved.replaceAll(" ", "_");
    }

    const normalized = data.query?.normalized;
    const lastNormalized = normalized?.at(-1);
    if (lastNormalized) {
      return lastNormalized.to.replaceAll(" ", "_");
    }

    return articleName;
  } catch (error: unknown) {
    logger.warn("Failed to resolve Wikipedia redirect, using original name", {
      articleName,
      error,
    });
    return articleName;
  }
}

export async function scrapeURLWithWikipedia(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const urlToScrape = meta.rewrittenUrl ?? meta.url;
  const wikiInfo = parseWikimediaUrl(urlToScrape);

  if (!wikiInfo) {
    throw new EngineError(
      `URL is not a supported Wikimedia URL: ${urlToScrape}`,
    );
  }

  const { articleName: rawArticleName, lang, projectIdentifier } = wikiInfo;

  const domain = new URL(urlToScrape).hostname.split(".").slice(1).join(".");
  const articleName = await resolveRedirect(
    rawArticleName,
    lang,
    domain,
    meta.logger,
  );

  meta.logger.info("Fetching from Wikipedia Enterprise API", {
    articleName,
    rawArticleName,
    lang,
    projectIdentifier,
  });

  const token = await getAccessToken(meta.logger);

  const apiUrl = `${WIKIMEDIA_API_BASE}/articles/${encodeURIComponent(articleName)}`;

  const response = await undiciFetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      filters: [
        {
          field: "is_part_of.identifier",
          value: projectIdentifier,
        },
      ],
      limit: 1,
    }),
  });

  if (response.status === 404) {
    throw new EngineError(
      `Wikipedia article not found: ${articleName} (${projectIdentifier})`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    clearCachedToken(meta.logger);
    throw new EngineError(
      `Wikipedia Enterprise API authorization failed (${response.status}). Check credentials.`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new EngineError(
      `Wikipedia Enterprise API error (${response.status}): ${body}`,
    );
  }

  const parsedArticles = wikimediaArticlesResponseSchema.safeParse(
    await response.json(),
  );
  if (!parsedArticles.success) {
    throw new EngineError(
      `Wikipedia Enterprise API returned an unexpected articles payload: ${parsedArticles.error.message}`,
    );
  }
  const articles = parsedArticles.data;

  if (!articles || articles.length === 0) {
    throw new EngineError(
      `No article data returned for: ${articleName} (${projectIdentifier})`,
    );
  }

  const article = articles[0];
  const html = article.article_body?.html;

  if (!html) {
    throw new EngineError(`Wikipedia article has no HTML body: ${articleName}`);
  }

  // Build a full HTML document wrapping the article content with metadata
  const categories = (article.categories ?? [])
    .filter(
      (c): c is { name: string; url: string } =>
        typeof c.name === "string" && typeof c.url === "string",
    )
    .map(c => `<li><a href="${c.url}">${c.name}</a></li>`)
    .join("");
  const toc = (article.has_parts ?? [])
    .filter((p): p is { name: string } => typeof p.name === "string")
    .map(p => `<li>${p.name}</li>`)
    .join("");

  const fullHtml = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <title>${article.name} - ${article.is_part_of?.name ?? "Wikipedia"}</title>
  <meta name="description" content="${escapeHtml(article.abstract ?? "")}">
  <meta property="og:title" content="${escapeHtml(article.name)}">
  <meta property="og:description" content="${escapeHtml(article.abstract ?? "")}">
  <meta property="og:url" content="${escapeHtml(article.url ?? urlToScrape)}">
  ${article.image?.content_url ? `<meta property="og:image" content="${escapeHtml(article.image.content_url)}">` : ""}
  <meta name="article:modified_time" content="${article.date_modified ?? ""}">
  <meta name="language" content="${article.in_language?.name ?? lang}">
</head>
<body>
  <article>
    <h1>${escapeHtml(article.name)}</h1>
    ${html}
  </article>
  ${toc ? `<nav><h2>Table of Contents</h2><ul>${toc}</ul></nav>` : ""}
  ${categories ? `<footer><h2>Categories</h2><ul>${categories}</ul></footer>` : ""}
</body>
</html>`;

  meta.logger.info("Wikipedia Enterprise API article fetched successfully", {
    articleName: article.name,
    language: article.in_language?.identifier,
    project: article.is_part_of?.identifier,
  });

  return {
    url: article.url ?? urlToScrape,
    html: fullHtml,
    statusCode: 200,
    contentType: "text/html; charset=utf-8",
    proxyUsed: "basic",
  };
}

function escapeHtml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function wikipediaMaxReasonableTime(_meta: Meta): number {
  return 10_000;
}

export function isWikimediaUrl(url: string): boolean {
  return parseWikimediaUrl(url) !== null;
}
