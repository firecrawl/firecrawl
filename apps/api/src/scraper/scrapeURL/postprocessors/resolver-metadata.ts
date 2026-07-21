import type { Meta } from "..";
import {
  resolveUrlMetadata,
  supportsUrlResolver,
} from "../../../lib/url-resolver";
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
    const resolvedMetadata = await resolveUrlMetadata(meta.url, meta.logger);
    if (!resolvedMetadata) {
      return engineResult;
    }

    return {
      ...engineResult,
      resolvedMetadata,
      postprocessorsUsed: [
        ...(engineResult.postprocessorsUsed ?? []),
        POSTPROCESSOR_NAME,
      ],
    };
  },
};
