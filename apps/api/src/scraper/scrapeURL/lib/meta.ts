import type { Logger } from "winston";
import {
  applyScrapeOptionsDefaults,
  ScrapeOptions,
} from "../../../controllers/v2/types";
import { InternalOptions } from "./internal-options";
import { AbortManager } from "./abortManager";
import { CostTracking } from "../../../lib/cost-tracking";
import { logger as _logger } from "../../../lib/logger";
import { ScrapeJobTimeoutError } from "../../../lib/error";
import { rewriteUrl } from "./rewriteUrl";
import { buildFeatureFlags, FeatureFlag } from "./feature-flags";
import { ZDRViolationError } from "../error";
import { BrowserCookie, EngineName } from "../engines/types";

export type Meta = {
  id: string;
  url: string;
  rewrittenUrl?: string;
  options: ScrapeOptions & { skipTlsVerification: boolean };
  internalOptions: InternalOptions;
  logger: Logger;
  abort: AbortManager;
  featureFlags: Set<FeatureFlag>;
  costTracking: CostTracking;
  winnerEngine?: EngineName;
  abortHandle?: NodeJS.Timeout;
  audioCookies?: BrowserCookie[];
  warnings?: string[];
};

export async function buildMetaObject(
  id: string,
  url: string,
  options: ScrapeOptions,
  internalOptions: InternalOptions,
  costTracking: CostTracking,
): Promise<Meta> {
  const logger = _logger.child({
    module: "ScrapeURL",
    scrapeId: id,
    scrapeURL: url,
    zeroDataRetention: internalOptions.zeroDataRetention,
    teamId: internalOptions.teamId,
    team_id: internalOptions.teamId,
    crawlId: internalOptions.crawlId,
  });

  const abortController = new AbortController();
  const abortHandle =
    options.timeout !== undefined
      ? setTimeout(
          () => abortController.abort(new ScrapeJobTimeoutError()),
          options.timeout,
        )
      : undefined;

  const effectiveOptions = applyScrapeOptionsDefaults(options);

  const ff = buildFeatureFlags(effectiveOptions, internalOptions);

  if (internalOptions.zeroDataRetention) {
    if (ff.flags.has("screenshot")) {
      throw new ZDRViolationError("screenshot");
    }

    if (ff.flags.has("screenshot@fullScreen")) {
      throw new ZDRViolationError("screenshot@fullScreen");
    }

    if (options.actions && options.actions.find(x => x.type === "screenshot")) {
      throw new ZDRViolationError("screenshot action");
    }

    if (options.actions && options.actions.find(x => x.type === "pdf")) {
      throw new ZDRViolationError("pdf action");
    }
  }

  return {
    id,
    url,
    rewrittenUrl: rewriteUrl(url),
    options: effectiveOptions,
    internalOptions,
    logger,
    abortHandle,
    abort: new AbortManager(
      internalOptions.externalAbort,
      options.timeout !== undefined
        ? {
            signal: abortController.signal,
            tier: "scrape",
            timesOutAt: new Date(Date.now() + options.timeout),
            throwable() {
              return new ScrapeJobTimeoutError();
            },
          }
        : undefined,
    ),
    featureFlags: ff.flags,
    costTracking,
    warnings: ff.warnings,
  };
}
