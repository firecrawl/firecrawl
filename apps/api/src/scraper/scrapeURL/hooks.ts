import type { Logger } from "winston";
import { requestContext } from "../../lib/request-context";
import type { Hooks, ScrapeMeta } from "../../service/hooks";
import { installedService } from "../../service/service";
import type { Meta } from ".";

export function scrapeHooks(): Hooks | undefined {
  return installedService()?.hooks;
}

export function toScrapeMeta(
  meta: Meta,
  logger: Logger = meta.logger,
): ScrapeMeta {
  const ctx =
    meta.ctx ??
    requestContext({
      teamId: meta.internalOptions?.teamId ?? "",
      zeroDataRetention: meta.internalOptions?.zeroDataRetention,
      flags: meta.internalOptions?.teamFlags,
      orgId: meta.internalOptions?.orgId,
    });
  const state = (meta.state ??= {});
  return {
    id: meta.id ?? "",
    url: meta.url,
    ctx,
    options: meta.options,
    state,
    logger,
    abort: meta.abort ? meta.abort.asSignal() : new AbortController().signal,
  };
}
