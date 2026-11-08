import { Client, type CrawlRequest } from "../client.js";
import { type Config, mergeProfiles } from "../config.js";
import { getFormat } from "../formats/index.js";
import { pickOutput } from "../outputs/index.js";
import { makeProgress } from "../progress.js";

export interface CrawlCmdOptions {
  url: string;
  config: Config;
  profileName: string;
  formatName: string;
  out: string | undefined;
  limit: number | undefined;
  maxDepth: number | undefined;
  includePaths: string[] | undefined;
  excludePaths: string[] | undefined;
  pollMs: number;
  progress: boolean;
}

export async function runCrawl(opts: CrawlCmdOptions): Promise<void> {
  const fmt = getFormat(opts.formatName);
  const client = new Client({ apiUrl: opts.config.apiUrl, retries: opts.config.retries });
  const writer = await pickOutput(opts.out);
  await writer.open();

  const merged = mergeProfiles(
    opts.config.profiles["default"],
    opts.config.profiles[opts.profileName],
  );

  const req: CrawlRequest = {
    url: opts.url,
    limit: opts.limit,
    maxDepth: opts.maxDepth,
    includePaths: opts.includePaths,
    excludePaths: opts.excludePaths,
    scrapeOptions: {
      formats: merged.formats && merged.formats.length > 0 ? merged.formats : fmt.apiFormats,
      onlyMainContent: merged.onlyMainContent,
      waitFor: merged.waitFor,
      includeTags: merged.includeTags,
      excludeTags: merged.excludeTags,
      headers: merged.headers,
      actions: merged.actions,
      timeout: merged.timeout,
    },
  };

  process.stderr.write(`starting crawl: ${opts.url}\n`);
  const id = await client.startCrawl(req);
  process.stderr.write(`crawl id: ${id}\n`);

  const progress = makeProgress({
    enabled: opts.progress,
    outputIsStdout: writer.isStdout,
  });
  let started = false;
  let writtenCount = 0;

  try {
    for await (const update of client.streamCrawl(id, opts.pollMs)) {
      if (!started && update.status.total > 0) {
        progress.start(update.status.total);
        started = true;
      }
      for (const page of update.pages) {
        const pageUrl =
          (page.metadata?.["sourceURL"] as string | undefined) ??
          (page.metadata?.["url"] as string | undefined) ??
          `${opts.url}#${writtenCount}`;
        const content = fmt.fromResponse(page);
        await writer.write(pageUrl, content, fmt.ext);
        writtenCount++;
        progress.tick(pageUrl);
      }
      if (update.status.status === "failed" || update.status.status === "cancelled") {
        process.stderr.write(`crawl ${update.status.status}: ${update.status.error ?? ""}\n`);
        break;
      }
    }
  } finally {
    progress.stop();
    await writer.close();
  }

  process.stderr.write(`done: ${writtenCount} pages written\n`);
}
