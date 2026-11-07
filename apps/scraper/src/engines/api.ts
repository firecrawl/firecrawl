import type { Client, ScrapeRequest } from "../client.js";
import type { ScrapeResponseData } from "../formats/types.js";
import type { Engine } from "./types.js";

export class ApiEngine implements Engine {
  readonly name = "api";

  constructor(private readonly client: Client) {}

  async scrape(req: ScrapeRequest, signal?: AbortSignal): Promise<ScrapeResponseData> {
    return this.client.scrape(req, signal);
  }
}
