import { Meta } from "..";
import { EngineScrapeResult } from "../engines";
import { resolverMetadataPostprocessor } from "./resolver-metadata";
import { youtubePostprocessor } from "./youtube";

export interface Postprocessor {
  name: string;
  shouldRun: (
    meta: Meta,
    url: URL,
    postProcessorsUsed?: string[],
  ) => boolean | Promise<boolean>;
  run: (
    meta: Meta,
    engineResult: EngineScrapeResult,
  ) => Promise<EngineScrapeResult>;
}

export const postprocessors: Postprocessor[] = [
  youtubePostprocessor,
  resolverMetadataPostprocessor,
];
