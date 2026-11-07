import { Command } from "commander";
import { loadConfig } from "./config.js";
import { runArchive } from "./commands/archive.js";
import { runBatch } from "./commands/batch.js";
import { runCrawl } from "./commands/crawl.js";
import { runMap } from "./commands/map.js";
import { runScrape } from "./commands/scrape.js";
import type { EngineName } from "./engines/index.js";
import { ArgInput } from "./inputs/arg.js";
import { FileInput } from "./inputs/file.js";
import { StdinInput } from "./inputs/stdin.js";
import type { InputSource } from "./inputs/types.js";
import { resolveUserPath } from "./lib/paths.js";

function resolvePath(p: string | undefined): string | undefined {
  return p === undefined ? undefined : resolveUserPath(p);
}

function parseEngine(v: unknown): EngineName | undefined {
  if (v === "api" || v === "cdp") return v;
  if (v === undefined) return undefined;
  throw new Error(`--engine must be "api" or "cdp", got "${String(v)}"`);
}

const program = new Command();

program
  .name("scraper")
  .description("CLI wrapper around self-hosted Firecrawl")
  .option("-c, --config <path>", "path to scraper.config.yaml", "scraper.config.yaml")
  .option("--api-url <url>", "override apiUrl from config")
  .option("--profile <name>", "named profile from config", "default")
  .option("-f, --format <name>", "markdown | html | json | screenshot", "markdown")
  .option("--engine <name>", "api | cdp (default: from profile/domain, else api)")
  .option("--cdp-url <url>", "Chrome DevTools Protocol URL (default: http://localhost:9222)");

program
  .command("scrape <url>")
  .description("Scrape a single URL")
  .option("-o, --out <path>", "output path (file, dir/, or '-' for stdout)")
  .action(async (url: string, _opts: Record<string, unknown>, cmd: Command) => {
    const g = program.opts();
    const config = await loadConfig(resolveUserPath(g["config"] as string));
    if (g["apiUrl"]) config.apiUrl = g["apiUrl"] as string;
    await runScrape({
      url,
      config,
      profileName: g["profile"] as string,
      formatName: g["format"] as string,
      out: resolvePath(cmd.opts()["out"] as string | undefined),
      engineOverride: parseEngine(g["engine"]),
      cdpUrlOverride: g["cdpUrl"] as string | undefined,
    });
  });

program
  .command("archive <url>")
  .description("Archive linked site pages and download images/direct videos")
  .option("-o, --out <path>", "archive root directory (default: checkout data/)")
  .option("--limit <n>", "maximum attempted pages", Number, 100)
  .option("--max-media-mb <n>", "maximum bytes per media file in decimal MB", Number, 100)
  .option("--delay-ms <n>", "minimum delay between page navigations", Number, 1000)
  .action(async (url: string, _opts: Record<string, unknown>, cmd: Command) => {
    const g = program.opts();
    const local = cmd.opts();
    const config = await loadConfig(resolveUserPath(g["config"] as string));
    if (g["apiUrl"]) config.apiUrl = g["apiUrl"] as string;
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const { manifest } = await runArchive({
        url,
        config,
        profileName: g["profile"] as string,
        engineName: parseEngine(g["engine"]) ?? "cdp",
        cdpUrlOverride: g["cdpUrl"] as string | undefined,
        out: resolvePath(local["out"] as string | undefined),
        limit: local["limit"] as number,
        maxMediaMb: local["maxMediaMb"] as number,
        delayMs: local["delayMs"] as number,
        signal: controller.signal,
      });
      if (manifest.status === "partial") process.exitCode = 1;
      if (manifest.status === "interrupted") process.exitCode = 130;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  });

program
  .command("batch")
  .description("Batch scrape from file, args, or stdin")
  .argument("[urls...]", "URLs (or use --file / --stdin)")
  .option("--file <path>", "read URLs from file (txt: one per line, .json: array)")
  .option("--stdin", "read URLs from stdin")
  .option("-o, --out <path>", "output path (file, dir/, or '-' for stdout)")
  .option("--concurrency <n>", "parallel requests", (v) => Number.parseInt(v, 10))
  .option("--resume", "skip URLs already in resume state", false)
  .option("--no-progress", "disable progress bar")
  .action(async (urls: string[], _opts: Record<string, unknown>, cmd: Command) => {
    const g = program.opts();
    const local = cmd.opts();
    const config = await loadConfig(resolveUserPath(g["config"] as string));
    if (g["apiUrl"]) config.apiUrl = g["apiUrl"] as string;

    let input: InputSource;
    let inputKey: string;
    if (local["file"]) {
      const filePath = resolveUserPath(local["file"] as string);
      input = new FileInput(filePath);
      inputKey = `file:${filePath}`;
    } else if (local["stdin"]) {
      input = new StdinInput();
      inputKey = "stdin";
    } else {
      if (urls.length === 0) {
        cmd.error("provide URLs as args, or use --file <path> / --stdin");
      }
      input = new ArgInput(urls);
      inputKey = `args:${urls.join(",")}`;
    }

    await runBatch({
      input,
      inputKey,
      config,
      profileName: g["profile"] as string,
      formatName: g["format"] as string,
      out: resolvePath(local["out"] as string | undefined),
      concurrency: (local["concurrency"] as number | undefined) ?? config.concurrency,
      resume: Boolean(local["resume"]),
      progress: local["progress"] !== false,
      engineOverride: parseEngine(g["engine"]),
      cdpUrlOverride: g["cdpUrl"] as string | undefined,
    });
  });

program
  .command("crawl <url>")
  .description("Crawl a site and save each page")
  .option("-o, --out <path>", "output path (file, dir/, or '-' for stdout)")
  .option("--limit <n>", "max pages", (v) => Number.parseInt(v, 10))
  .option("--max-depth <n>", "max link depth", (v) => Number.parseInt(v, 10))
  .option("--include-paths <patterns...>", "regex(es) of paths to include")
  .option("--exclude-paths <patterns...>", "regex(es) of paths to exclude")
  .option("--poll-ms <ms>", "polling interval", (v) => Number.parseInt(v, 10), 2000)
  .option("--no-progress", "disable progress bar")
  .action(async (url: string, _opts: Record<string, unknown>, cmd: Command) => {
    const g = program.opts();
    const local = cmd.opts();
    const config = await loadConfig(resolveUserPath(g["config"] as string));
    if (g["apiUrl"]) config.apiUrl = g["apiUrl"] as string;
    await runCrawl({
      url,
      config,
      profileName: g["profile"] as string,
      formatName: g["format"] as string,
      out: resolvePath(local["out"] as string | undefined),
      limit: local["limit"] as number | undefined,
      maxDepth: local["maxDepth"] as number | undefined,
      includePaths: local["includePaths"] as string[] | undefined,
      excludePaths: local["excludePaths"] as string[] | undefined,
      pollMs: (local["pollMs"] as number | undefined) ?? 2000,
      progress: local["progress"] !== false,
    });
  });

program
  .command("map <url>")
  .description("List URLs reachable from a site (no scraping)")
  .option("-o, --out <path>", "output path (file or '-' for stdout)")
  .option("--search <query>", "filter URLs by text")
  .option("--limit <n>", "max URLs", (v) => Number.parseInt(v, 10))
  .option("--ignore-sitemap", "skip sitemap.xml", false)
  .option("--include-subdomains", "include subdomain URLs", false)
  .action(async (url: string, _opts: Record<string, unknown>, cmd: Command) => {
    const g = program.opts();
    const local = cmd.opts();
    const config = await loadConfig(resolveUserPath(g["config"] as string));
    if (g["apiUrl"]) config.apiUrl = g["apiUrl"] as string;
    await runMap({
      url,
      config,
      search: local["search"] as string | undefined,
      limit: local["limit"] as number | undefined,
      ignoreSitemap: Boolean(local["ignoreSitemap"]),
      includeSubdomains: Boolean(local["includeSubdomains"]),
      out: resolvePath(local["out"] as string | undefined),
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
