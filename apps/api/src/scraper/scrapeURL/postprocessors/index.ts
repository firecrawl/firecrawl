import { Meta } from "..";
import { EngineScrapeResult } from "../engines";
import { videoMetadataPostprocessor } from "./video-metadata";

export interface Postprocessor {
  name: string;
  /** Must never throw — a failing eligibility check means "don't run". */
  shouldRun: (meta: Meta, url: URL) => Promise<boolean>;
  run: (
    meta: Meta,
    engineResult: EngineScrapeResult,
  ) => Promise<EngineScrapeResult>;
}

export const postprocessors: Postprocessor[] = [videoMetadataPostprocessor];
