import type { ScrapeRequest } from "../client.js";
import type { ScrapeResponseData } from "../formats/types.js";

export type EngineName = "api" | "cdp";

export interface Engine {
  readonly name: EngineName;
  scrape(req: ScrapeRequest, signal?: AbortSignal): Promise<ScrapeResponseData>;
  prepare?(): Promise<void>;
  downloadHeaders?(url: string): Promise<Record<string, string>>;
  close?(): Promise<void>;
}
