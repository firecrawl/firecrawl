import type { Meta } from "..";
import { resolveUrl, supportsUrlResolver } from "../../../lib/url-resolver";
import type { EngineScrapeResult } from "../engines";
import type { Postprocessor } from ".";

const POSTPROCESSOR_NAME = "resolver-metadata";

export const resolverMetadataPostprocessor: Postprocessor = {
  name: POSTPROCESSOR_NAME,
  shouldRun: async (meta: Meta, _url: URL, postprocessorsUsed?: string[]) => {
    if (
      meta.options.lockdown ||
      postprocessorsUsed?.includes(POSTPROCESSOR_NAME)
    ) {
      return false;
    }

    return supportsUrlResolver(meta.url);
  },
  run: async (meta: Meta, engineResult: EngineScrapeResult) => {
    const resolved = await resolveUrl(meta.url, 0, meta.logger);
    if (!resolved?.metadata) {
      return engineResult;
    }

    return {
      ...engineResult,
      resolvedMetadata: resolved.metadata,
      postprocessorsUsed: [
        ...(engineResult.postprocessorsUsed ?? []),
        POSTPROCESSOR_NAME,
      ],
    };
  },
};
