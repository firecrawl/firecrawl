import { RobotsParser } from "@mendable/firecrawl-rs";
import { Logger } from "winston";
import {
  getV2RequestSchemas,
  ScrapeOptions,
  scrapeOptionsAcceptsMaxAge,
} from "../controllers/v2/types";
import { scrapeURL } from "../scraper/scrapeURL";
import { Engine } from "../scraper/scrapeURL/engines";
import type { RequestContext } from "../service/request-context";
import { installedService } from "../service/service";
import { CostTracking } from "./cost-tracking";

const ROBOTS_MAX_AGE = 1 * 24 * 60 * 60 * 1000;

export interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean;
  getMatchingLineNumber(url: string, ua?: string): number;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
  getPreferredHost(): string | undefined;
}

class RustRobot implements Robot {
  readonly parser: RobotsParser;

  constructor(robotsTxtUrl: string, contents: string) {
    this.parser = new RobotsParser(robotsTxtUrl, contents);
  }

  isAllowed(url: string, ua?: string): boolean | undefined {
    return this.parser.isAllowed(url, ua) ?? undefined;
  }

  isDisallowed(url: string, ua?: string): boolean {
    return this.parser.isDisallowed(url, ua);
  }

  getMatchingLineNumber(url: string, ua?: string): number {
    return this.parser.getMatchingLineNumber(url, ua);
  }

  getCrawlDelay(ua?: string): number | undefined {
    return this.parser.getCrawlDelay(ua) ?? undefined;
  }

  getSitemaps(): string[] {
    return this.parser.getSitemaps();
  }

  getPreferredHost(): string | undefined {
    return this.parser.getPreferredHost() ?? undefined;
  }
}

export function parseRobotsTxt(robotsTxtUrl: string, contents: string): Robot {
  return new RustRobot(robotsTxtUrl, contents);
}

interface RobotsTxtChecker {
  robotsTxtUrl: string;
  robotsTxt: string;
  robots: Robot;
}

export async function fetchRobotsTxt(
  {
    url,
    zeroDataRetention,
    usOnly,
    location,
    headers,
    skipCache,
    skipTlsVerification,
  }: {
    url: string;
    zeroDataRetention: boolean;
    usOnly?: boolean;
    skipTlsVerification?: boolean;
    location?: ScrapeOptions["location"];
    headers?: Record<string, string>;
    skipCache?: boolean;
  },
  scrapeId: string,
  logger: Logger,
  abort?: AbortSignal,
): Promise<{ content: string; url: string }> {
  const urlObj = new URL(url);
  const robotsTxtUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;

  const forceEngine: Engine[] = ["fetch"];
  const parentCtx: RequestContext = {
    teamId: "robots-txt",
    zeroDataRetention,
    ...(usOnly ? { usOnly: true } : {}),
  };
  const systemCtx =
    installedService()?.modules.policy.system("robots-txt", parentCtx) ??
    parentCtx;

  let content: string = "";
  const response = await scrapeURL(
    "robots-txt;" + scrapeId,
    robotsTxtUrl,
    (() => {
      const schema = getV2RequestSchemas().scrapeOptions;
      return schema.parse({
        formats: ["rawHtml"],
        timeout: 8000,
        ...(scrapeOptionsAcceptsMaxAge(schema)
          ? { maxAge: skipCache ? 0 : ROBOTS_MAX_AGE }
          : {}),
        ...(location ? { location } : {}),
        ...(headers ? { headers } : {}),
        ...(skipTlsVerification ? { skipTlsVerification } : {}),
      });
    })(),
    {
      ctx: systemCtx,
      forceEngine,
      v0DisableJsDom: true,
      orgId: null,
      externalAbort: abort
        ? {
            signal: abort,
            tier: "external",
            throwable() {
              return new Error("Robots.txt fetch aborted");
            },
          }
        : undefined,
      teamId: systemCtx.teamId,
      zeroDataRetention: systemCtx.zeroDataRetention,
    },
    new CostTracking(),
  );

  if (
    response.success &&
    response.document.metadata.statusCode >= 200 &&
    response.document.metadata.statusCode < 300
  ) {
    content = response.document.rawHtml!;
  } else {
    if (response.success && response.document.metadata.statusCode === 404) {
      logger.warn("Robots.txt not found", { robotsTxtUrl }); // should probably index 404 robots.txt
      return { content: "", url: robotsTxtUrl };
    }

    logger.error(`Request failed for robots.txt fetch`, {
      method: "fetchRobotsTxt",
      robotsTxtUrl,
      error: response.success
        ? response.document.metadata.statusCode
        : response.error,
    });
    return { content: "", url: robotsTxtUrl };
  }

  // return URL in case we've been redirected
  return {
    content: content,
    url: response.document.metadata.url || robotsTxtUrl,
  };
}

export function createRobotsChecker(
  url: string,
  robotsTxt: string,
): RobotsTxtChecker {
  const urlObj = new URL(url);
  const robotsTxtUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
  const robots = parseRobotsTxt(robotsTxtUrl, robotsTxt);
  return {
    robotsTxtUrl,
    robotsTxt,
    robots,
  };
}

export function isUrlAllowedByRobots(
  url: string,
  robots: Robot | null,
  userAgents: string[] = ["FireCrawlAgent", "FirecrawlAgent"],
): boolean {
  if (!robots) return true;
  if (robots instanceof RustRobot) {
    return robots.parser.isUrlAllowedByRobots(url, userAgents);
  }

  for (const userAgent of userAgents) {
    let isAllowed = robots.isAllowed(url, userAgent) ?? true;

    if (isAllowed && !url.endsWith("/")) {
      const isAllowedWithSlash = robots.isAllowed(url + "/", userAgent) ?? true;
      if (isAllowedWithSlash === false) {
        isAllowed = false;
      }
    }

    if (isAllowed) {
      return true;
    }
  }

  return false;
}
