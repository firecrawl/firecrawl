import { Client } from "../client.js";
import type { Config } from "../config.js";
import { pickOutput } from "../outputs/index.js";

export interface MapCmdOptions {
  url: string;
  config: Config;
  search: string | undefined;
  limit: number | undefined;
  ignoreSitemap: boolean;
  includeSubdomains: boolean;
  out: string | undefined;
}

export async function runMap(opts: MapCmdOptions): Promise<void> {
  const client = new Client({ apiUrl: opts.config.apiUrl, retries: opts.config.retries });
  const links = await client.map({
    url: opts.url,
    search: opts.search,
    limit: opts.limit,
    ignoreSitemap: opts.ignoreSitemap,
    includeSubdomains: opts.includeSubdomains,
  });

  if (!opts.out || opts.out === "-") {
    for (const link of links) process.stdout.write(`${link}\n`);
    return;
  }

  const writer = await pickOutput(opts.out);
  await writer.open();
  try {
    if (opts.out.endsWith(".json")) {
      await writer.write(opts.url, JSON.stringify(links, null, 2), ".json");
    } else {
      await writer.write(opts.url, links.join("\n") + "\n", ".txt");
    }
  } finally {
    await writer.close();
  }
}
