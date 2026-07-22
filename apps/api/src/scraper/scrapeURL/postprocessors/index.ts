import { Meta } from "..";
import { EngineScrapeResult } from "../engines";
import { youtubePostprocessor } from "./youtube";

export interface Postprocessor {
  name: string;
  shouldRun: (meta: Meta, url: URL, postProcessorsUsed?: string[]) => boolean;
  run: (
    meta: Meta,
    engineResult: EngineScrapeResult,
  ) => Promise<EngineScrapeResult>;
}

export const postprocessors: Postprocessor[] = [youtubePostprocessor];
