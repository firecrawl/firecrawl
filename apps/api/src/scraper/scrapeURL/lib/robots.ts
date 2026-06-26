import type { Span } from "@sentry/core";
import { TeamFlags } from "../../../controllers/v2/types";
import { getCrawl } from "../../../lib/crawl-redis";
import { CrawlDenialError } from "../../../lib/error";
import { setSpanAttributes, withSpan } from "../../../lib/otel-tracer";
import {
  createRobotsChecker,
  fetchRobotsTxt,
  isUrlAllowedByRobots,
} from "../../../lib/robots-txt";
import { Meta } from "./meta";

// The invariant "lockdown never fetches robots.txt" is load-bearing for the
// lockdown guarantee (robots.txt is a request to the target domain). Keep this
// in its own file so it can be unit-tested without dragging in scrapeURL's
// ESM-heavy module graph.
function shouldCheckRobots(
  options: { lockdown?: boolean },
  internalOptions: { teamFlags?: TeamFlags },
): boolean {
  if (options.lockdown) {
    return false;
  }
  return !!internalOptions.teamFlags?.checkRobotsOnScrape;
}

export async function doRobotsCheckIfNeeded(meta: Meta, span: Span) {
  if (shouldCheckRobots(meta.options, meta.internalOptions)) {
    await withSpan("scrape.robots_check", async robotsSpan => {
      const urlToCheck = meta.rewrittenUrl || meta.url;
      meta.logger.info("Checking robots.txt", { url: urlToCheck });

      const urlObj = new URL(urlToCheck);
      const isRobotsTxtPath = urlObj.pathname === "/robots.txt";

      setSpanAttributes(robotsSpan, {
        "robots.url": urlToCheck,
        "robots.is_robots_txt_path": isRobotsTxtPath,
      });

      if (!isRobotsTxtPath) {
        try {
          let robotsTxt: string | undefined;
          if (meta.internalOptions.crawlId) {
            const crawl = await getCrawl(meta.internalOptions.crawlId);
            robotsTxt = crawl?.robots;
          }

          if (!robotsTxt) {
            const { content } = await fetchRobotsTxt(
              {
                url: urlToCheck,
                zeroDataRetention:
                  meta.internalOptions.zeroDataRetention || false,
                location: meta.options.location,
              },
              meta.id,
              meta.logger,
              meta.abort.asSignal(),
            );
            robotsTxt = content;
          }

          const checker = createRobotsChecker(urlToCheck, robotsTxt);
          const isAllowed = isUrlAllowedByRobots(urlToCheck, checker.robots);

          setSpanAttributes(robotsSpan, {
            "robots.allowed": isAllowed,
          });

          if (!isAllowed) {
            meta.logger.info("URL blocked by robots.txt", {
              url: urlToCheck,
            });
            setSpanAttributes(span, {
              "scrape.blocked_by_robots": true,
            });
            throw new CrawlDenialError("URL blocked by robots.txt");
          }
        } catch (error) {
          if (error instanceof CrawlDenialError) {
            throw error;
          }
          meta.logger.debug("Failed to fetch robots.txt, allowing scrape", {
            error,
            url: urlToCheck,
          });
          setSpanAttributes(robotsSpan, {
            "robots.fetch_failed": true,
          });
        }
      }
    }).catch(error => {
      if (error.message === "URL blocked by robots.txt") {
        return {
          success: false,
          error,
        };
      }
      throw error;
    });
  }
}
