import { defineCommand, type IFileSystem } from "just-bash";

const ORIGIN = "bash";
const INTEGRATION = "_firecrawl-bash";
const INSTALL = "npx -y firecrawl-cli@latest init";
const SEARCH_SOURCES = ["web", "images", "news"];
const SEARCH_CATEGORIES = ["research", "pdf", "developer", "gov"];
// Every format the CLI accepts; the hosted shell serves SCRAPE_FORMATS of them.
const CLI_FORMATS = [
  "markdown",
  "html",
  "rawHtml",
  "links",
  "images",
  "screenshot",
  "summary",
  "changeTracking",
  "json",
  "attributes",
  "branding",
];
const SCRAPE_FORMATS = [
  "markdown",
  "html",
  "rawHtml",
  "links",
  "images",
  "summary",
];
const API_KEY_FLAG =
  "--api-key isn't accepted in the hosted shell. Send your key in the HTTP request's Authorization: Bearer fc-... header instead";
const KEY_NEEDED =
  "Firecrawl's free tier without an API key isn't available from your network (it needs an IPv4 address). Create a free API key at https://www.firecrawl.dev/signin and send it as Authorization: Bearer fc-...";

export interface FirecrawlCaller {
  /** This server's own address: calls go through the same routes a REST caller uses. */
  baseUrl: string;
  ip: string | null;
  /** The caller's Authorization header as sent, so the API parses it as it would directly. */
  authorization: string | null;
  /** Caller headers kept on each call: User-Agent and a World ID credential. */
  headers: Record<string, string>;
  maxCalls: number;
  /** When the command must be done; each call asks the API to finish before it. */
  deadline: number;
}

// Room to read the response and print it before the command's deadline.
const CALL_MARGIN_MS = 3_000;

type Endpoint = "search" | "scrape";

/** Calls the API as the shell's caller and records what was called, for analytics. */
export class FirecrawlClient {
  readonly endpoints: Endpoint[] = [];
  readonly failedEndpoints: Endpoint[] = [];

  constructor(private readonly caller: FirecrawlCaller) {}

  async post(
    endpoint: Endpoint,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    const { baseUrl, ip, authorization, headers, maxCalls, deadline } =
      this.caller;
    if (this.endpoints.length >= maxCalls) {
      throw new Error(
        `call limit reached (${maxCalls} Firecrawl calls per command)`,
      );
    }
    // A call the API is still working on at the deadline would be billed but lost.
    const timeout = deadline - Date.now() - CALL_MARGIN_MS;
    if (timeout < 1_000) {
      throw new Error("not enough time left before the command's deadline");
    }
    this.endpoints.push(endpoint);
    const res = await fetch(`${baseUrl}/v2/${endpoint}`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
        // This request arrives from loopback, a trusted hop under
        // EXPRESS_TRUST_PROXY, so auth and quotas see the caller's IP.
        ...(ip ? { "X-Forwarded-For": ip } : {}),
      },
      body: JSON.stringify({
        ...body,
        timeout,
        origin: ORIGIN,
        integration: INTEGRATION,
      }),
      signal,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.success === false) {
      this.failedEndpoints.push(endpoint);
      // Keyless refuses an IPv6 caller with a bare 401.
      const bare = !json?.error || json.error === "Unauthorized";
      if (!authorization && res.status === 401 && bare) {
        throw new Error(KEY_NEEDED);
      }
      throw new Error(apiError(json, res.status));
    }
    return json;
  }
}

/** The API's error, with the first few validation issues it lists. */
function apiError(json: any, status: number): string {
  const message = json?.error || `Firecrawl request failed (HTTP ${status})`;
  const issues: string[] = Array.isArray(json?.details)
    ? json.details
        .slice(0, 3)
        .filter((d: any) => typeof d?.message === "string")
        .map((d: any) =>
          Array.isArray(d.path) && d.path.length
            ? `${d.path.join(".")}: ${d.message}`
            : d.message,
        )
    : [];
  return issues.length ? `${message} (${issues.join("; ")})` : message;
}

export const FIRECRAWL_HELP = `Usage: firecrawl [command] [options]

A hosted subset of the Firecrawl CLI. The flags and output follow the real CLI
(/docs/sdks/cli.md); install it for everything else: ${INSTALL}

Commands:
  search <query>        Search the web
    --limit <number>              Maximum number of results (default: 5)
    --sources <sources>           Comma-separated sources: web, images, news (default: web)
    --categories <categories>     Comma-separated categories: ${SEARCH_CATEGORIES.join(", ")}
    --tbs <value>                 Time-based search: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y
    --location <location>         Location for geo-targeting
    --country <code>              ISO country code for geo-targeting
    --scrape                      Enable scraping of search results
    --scrape-formats <formats>    Comma-separated scrape formats when --scrape is enabled (default: markdown)
    -o, --output <path>           Output file path (default: stdout)
    --json                        Output as compact JSON
    --pretty                      Output as pretty JSON

  scrape [urls...]      Scrape URLs. Multiple URLs are saved to .firecrawl/
    -f, --format <formats>        Output format(s): ${SCRAPE_FORMATS.join(", ")}.
                                  Single format outputs raw content; multiple formats output JSON.
    -H, --html                    Output raw HTML (shortcut for --format html)
    -S, --summary                 Output summary (shortcut for --format summary)
    --only-main-content           Include only the main content (the API default)
    --full-page                   Keep the whole page, including navigation, headers and footers
    --wait-for <ms>               Wait time before scraping in milliseconds
    --include-tags <tags>         Comma-separated list of tags to include
    --exclude-tags <tags>         Comma-separated list of tags to exclude
    --max-age <milliseconds>      Maximum age of cached content in milliseconds
    --country <code>              ISO country code for geo-targeted scraping
    -o, --output <path>           Output file path (default: stdout)
    --json                        Output as JSON format
    --pretty                      Pretty print JSON output

  help                  Display this help
`;

/** Thrown for anything the hosted subset leaves out; exits 2, unlike a failed call. */
class Unsupported extends Error {}

type Flags = Record<string, string | true>;

interface FlagSpec {
  values: string[];
  booleans: string[];
  aliases: Record<string, string>;
}

const SEARCH_FLAGS: FlagSpec = {
  values: [
    "limit",
    "sources",
    "categories",
    "tbs",
    "location",
    "country",
    "scrape-formats",
    "output",
  ],
  booleans: ["scrape", "json", "pretty"],
  aliases: { o: "output" },
};

const SCRAPE_FLAGS: FlagSpec = {
  values: [
    "url",
    "format",
    "wait-for",
    "include-tags",
    "exclude-tags",
    "max-age",
    "country",
    "output",
  ],
  booleans: [
    "html",
    "summary",
    "only-main-content",
    "full-page",
    "json",
    "pretty",
  ],
  aliases: {
    u: "url",
    f: "format",
    formats: "format",
    H: "html",
    S: "summary",
    o: "output",
  },
};

function parseArgs(args: string[], spec: FlagSpec) {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    const match = /^(?:--([\w-]+)|-([A-Za-z]))(?:=(.*))?$/s.exec(arg);
    if (!match) {
      positional.push(arg);
      continue;
    }
    const raw = match[1] ?? match[2];
    const name = spec.aliases[raw] ?? raw;
    const shown = match[1] ? `--${raw}` : `-${raw}`;
    if (spec.booleans.includes(name)) {
      flags[name] = true;
    } else if (!spec.values.includes(name)) {
      throw new Unsupported(`option '${shown}' isn't in the hosted shell`);
    } else if (match[3] !== undefined) {
      flags[name] = match[3];
    } else if (i + 1 < args.length) {
      flags[name] = args[++i];
    } else {
      throw new Error(`option '${shown}' argument missing`);
    }
  }
  return { positional, flags };
}

const text = (flags: Flags, name: string) =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined;

function integer(flags: Flags, name: string): number | undefined {
  const value = text(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`option '--${name}' expects a number`);
  }
  return parsed;
}

const list = (value: string | undefined) =>
  value
    ?.split(",")
    .map(item => item.trim())
    .filter(Boolean);

interface Context {
  client: FirecrawlClient;
  fs: IFileSystem;
  cwd: string;
  signal?: AbortSignal;
  stderr: string[];
}

/** The CLI's writeOutput: a file when a path is given, otherwise stdout ending in a newline. */
async function output(c: Context, content: string, path: string | undefined) {
  if (!path) return content.endsWith("\n") ? content : `${content}\n`;
  const absolute = path.startsWith("/")
    ? path
    : `${c.cwd.replace(/\/$/, "")}/${path}`;
  const dir = absolute.slice(0, absolute.lastIndexOf("/")) || "/";
  await c.fs.mkdir(dir, { recursive: true });
  await c.fs.writeFile(absolute, content);
  return "";
}

const wantsJson = (flags: Flags, path: string | undefined) =>
  Boolean(flags.json) || Boolean(path?.toLowerCase().endsWith(".json"));

const stringify = (flags: Flags, value: unknown) =>
  flags.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);

function scrapedContent(markdown: unknown): string[] {
  if (typeof markdown !== "string" || !markdown) return [];
  const indented = markdown
    .split("\n")
    .map(line => `  ${line}`)
    .join("\n");
  return ["", "  --- Content ---", indented, "  --- End Content ---"];
}

function readableSearch(data: any, labelWeb: boolean): string {
  const lines: string[] = [];
  if (data.web?.length) {
    if (labelWeb) lines.push("=== Web Results ===", "");
    for (const r of data.web) {
      lines.push(r.title || "Untitled", `  URL: ${r.url}`);
      if (r.description) lines.push(`  ${r.description}`);
      if (r.category) lines.push(`  Category: ${r.category}`);
      lines.push(...scrapedContent(r.markdown), "");
    }
  }
  if (data.images?.length) {
    if (lines.length) lines.push("");
    lines.push("=== Image Results ===", "");
    for (const r of data.images) {
      lines.push(
        r.title || "Untitled",
        `  Image URL: ${r.imageUrl}`,
        `  Source: ${r.url}`,
      );
      if (r.imageWidth && r.imageHeight) {
        lines.push(`  Size: ${r.imageWidth}x${r.imageHeight}`);
      }
      lines.push("");
    }
  }
  if (data.news?.length) {
    if (lines.length) lines.push("");
    lines.push("=== News Results ===", "");
    for (const r of data.news) {
      lines.push(r.title || "Untitled", `  URL: ${r.url}`);
      if (r.date) lines.push(`  Date: ${r.date}`);
      if (r.snippet) lines.push(`  ${r.snippet}`);
      lines.push(...scrapedContent(r.markdown), "");
    }
  }
  return lines.join("\n");
}

async function search(c: Context, args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args, SEARCH_FLAGS);
  const query = positional.join(" ");
  if (!query) throw new Error("missing required argument 'query'");
  const named = list(text(flags, "sources"))?.map(s => s.toLowerCase());
  const sources = named?.length ? [...new Set(named)] : ["web"];
  for (const source of sources) {
    if (!SEARCH_SOURCES.includes(source)) {
      throw new Unsupported(
        `source "${source}" isn't in the hosted shell, which has ${SEARCH_SOURCES.join(", ")}`,
      );
    }
  }
  const categories = list(text(flags, "categories"))?.map(c => c.toLowerCase());
  for (const category of categories ?? []) {
    if (category === "github") {
      throw new Error(
        "The github category was removed. Use --categories developer",
      );
    }
    if (!SEARCH_CATEGORIES.includes(category)) {
      throw new Error(
        `Invalid category "${category}". Valid categories are: ${SEARCH_CATEGORIES.join(", ")}`,
      );
    }
  }
  const scrapeFormats = list(text(flags, "scrape-formats")) ?? ["markdown"];
  const optional = (key: string, flag = key) =>
    text(flags, flag) ? { [key]: text(flags, flag) } : {};

  const envelope = await c.client.post(
    "search",
    {
      query,
      limit: integer(flags, "limit") ?? 5,
      sources: sources.map(type => ({ type })),
      // The CLI gets highlighted descriptions by default; ask for the same.
      highlights: true,
      ...(categories ? { categories: categories.map(type => ({ type })) } : {}),
      ...optional("tbs"),
      ...optional("location"),
      ...optional("country"),
      ...(flags.scrape
        ? { scrapeOptions: { formats: scrapeFormats.map(type => ({ type })) } }
        : {}),
    },
    c.signal,
  );
  const data = envelope.data ?? {};
  const path = text(flags, "output");
  if (!data.web?.length && !data.images?.length && !data.news?.length) {
    return "No results found.\n";
  }
  if (flags.json || flags.pretty) {
    const result = {
      success: true,
      data,
      ...(envelope.warning ? { warning: envelope.warning } : {}),
      ...(envelope.id ? { id: envelope.id } : {}),
      ...(envelope.creditsUsed !== undefined
        ? { creditsUsed: envelope.creditsUsed }
        : {}),
    };
    return output(c, stringify(flags, result), path);
  }
  return output(c, readableSearch(data, sources.length > 1), path);
}

function scrapeBody(url: string, formats: string[], flags: Flags) {
  const waitFor = integer(flags, "wait-for");
  const maxAge = integer(flags, "max-age");
  const includeTags = list(text(flags, "include-tags"));
  const excludeTags = list(text(flags, "exclude-tags"));
  const country = text(flags, "country");
  return {
    url,
    formats,
    ...(flags["full-page"]
      ? { onlyMainContent: false }
      : flags["only-main-content"]
        ? { onlyMainContent: true }
        : {}),
    ...(waitFor !== undefined ? { waitFor } : {}),
    ...(includeTags ? { includeTags } : {}),
    ...(excludeTags ? { excludeTags } : {}),
    ...(maxAge !== undefined ? { maxAge } : {}),
    ...(country ? { location: { country } } : {}),
  };
}

/** A single text format prints as raw content, as the CLI's extractContent does. */
function rawContent(data: any, format: string): string | null {
  const value =
    format === "html" || format === "rawHtml"
      ? data.html || data.rawHtml
      : data[format];
  if (Array.isArray(value)) return value.join("\n");
  return typeof value === "string" && value ? value : null;
}

/** The CLI's parseFormats: comma-separated, any case, in the API's casing. */
function parseFormats(value: string): string[] {
  const formats = value
    .split(",")
    .map(format => format.trim())
    .filter(Boolean)
    .map(format => {
      const known = CLI_FORMATS.find(
        name => name.toLowerCase() === format.toLowerCase(),
      );
      if (!known) {
        throw new Error(
          `Invalid format(s): ${format}. Valid formats are: ${CLI_FORMATS.join(", ")}`,
        );
      }
      return known;
    });
  return [...new Set(formats)];
}

function isFormatList(value: string): boolean {
  try {
    return parseFormats(value).length > 0;
  } catch {
    return false;
  }
}

const normalizeUrl = (url: string) =>
  /^https?:\/\//i.test(url) ? url : `https://${url}`;

/** The CLI's isScrapeUrl: an http(s) URL, or a host with a dot, localhost or an IPv6 literal. */
function isScrapeUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) {
    const host = value.split(/[/?#]/, 1)[0];
    const hostLike =
      host.includes(".") ||
      /^localhost(?::\d+)?$/i.test(host) ||
      host.startsWith("[");
    if (!hostLike) return false;
  }
  try {
    return Boolean(new URL(normalizeUrl(value)).hostname);
  } catch {
    return false;
  }
}

/** The CLI's isUrl, which decides when `firecrawl <url>` means scrape. */
function isShorthandUrl(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true;
  return (
    value.includes(".") &&
    !value.startsWith("-") &&
    /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}(\/.*)?$/.test(
      value,
    )
  );
}

function urlToFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "-");
    return path ? `${host}-${path}.md` : `${host}.md`;
  } catch {
    return `${url.replace(/[^a-zA-Z0-9.-]/g, "_")}.md`;
  }
}

async function scrape(c: Context, args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args, SCRAPE_FLAGS);
  // As in the CLI, each word is a URL or formats: `firecrawl scrape example.com markdown,links`.
  const urls: string[] = [];
  const positionalFormats: string[] = [];
  for (const word of [
    ...positional,
    ...(text(flags, "url") ? [text(flags, "url") as string] : []),
  ]) {
    if (isScrapeUrl(word)) {
      const url = normalizeUrl(word);
      if (!urls.includes(url)) urls.push(url);
    } else if (isFormatList(word))
      positionalFormats.push(...parseFormats(word));
    else {
      throw new Error(
        `${JSON.stringify(word)} isn't a URL. For a website, use an http(s) URL, for example https://example.com`,
      );
    }
  }
  if (!urls.length) {
    throw new Error(
      "Provide a URL to scrape, e.g. firecrawl scrape https://example.com",
    );
  }
  if (flags["only-main-content"] && flags["full-page"]) {
    throw new Error("Use either --only-main-content or --full-page, not both");
  }
  const formats = positionalFormats.length
    ? [...new Set(positionalFormats)]
    : flags.html
      ? ["html"]
      : flags.summary
        ? ["summary"]
        : text(flags, "format")
          ? parseFormats(text(flags, "format") as string)
          : ["markdown"];
  for (const format of formats) {
    if (!SCRAPE_FORMATS.includes(format)) {
      throw new Unsupported(
        `format "${format}" isn't in the hosted shell, which has ${SCRAPE_FORMATS.join(", ")}`,
      );
    }
  }

  if (urls.length > 1) {
    c.stderr.push(`Scraping ${urls.length} URLs...`);
    let done = 0;
    let failed = 0;
    await Promise.all(
      urls.map(async url => {
        try {
          const body = scrapeBody(url, formats, flags);
          const data = (await c.client.post("scrape", body, c.signal)).data;
          const path = `.firecrawl/${urlToFilename(url)}`;
          // As the CLI does: markdown, or the whole response, whatever the format.
          await output(c, data?.markdown || JSON.stringify(data ?? {}), path);
          c.stderr.push(`[${++done}/${urls.length}] Saved: ${path}`);
        } catch (error) {
          failed++;
          c.stderr.push(
            `[${++done}/${urls.length}] Error: ${url} - ${(error as Error).message}`,
          );
        }
      }),
    );
    c.stderr.push(
      "",
      `Completed: ${urls.length - failed}/${urls.length} succeeded${failed ? `, ${failed} failed` : ""}`,
    );
    if (failed === urls.length) throw new Error("every URL failed");
    return "";
  }

  const body = scrapeBody(urls[0], formats, flags);
  const data = (await c.client.post("scrape", body, c.signal)).data ?? {};
  const path = text(flags, "output");
  if (wantsJson(flags, path)) return output(c, stringify(flags, data), path);
  const raw = formats.length === 1 ? rawContent(data, formats[0]) : null;
  if (raw !== null) return output(c, raw, path);
  const picked = Object.fromEntries(
    [...formats, "metadata"]
      .filter(key => data[key] !== undefined)
      .map(key => [key, data[key]]),
  );
  return output(
    c,
    stringify(flags, formats.length === 1 ? data : picked),
    path,
  );
}

export function firecrawlCommand(client: FirecrawlClient) {
  return defineCommand("firecrawl", async (argv, ctx) => {
    // As in the CLI, `firecrawl <url>` is short for `firecrawl scrape <url>`.
    const [name, ...rest] = isShorthandUrl(argv[0] ?? "")
      ? ["scrape", ...argv]
      : argv;
    const stderr: string[] = [];
    const result = (stdout: string, exitCode: number) => ({
      stdout,
      stdoutKind: "text" as const,
      stderr: stderr.length ? `${stderr.join("\n")}\n` : "",
      exitCode,
    });
    // A bare `help` is only the help command up front: `search help desk` is a query.
    const end = rest.indexOf("--");
    const options = end === -1 ? rest : rest.slice(0, end);
    if ([name, ...options].some(arg => /^(--api-key|-k)(=|$)/.test(arg))) {
      stderr.push(`Error: ${API_KEY_FLAG}`);
      return result("", 1);
    }
    const asksHelp = options.some(arg => arg === "--help" || arg === "-h");
    if (!name || ["help", "--help", "-h"].includes(name) || asksHelp) {
      return result(FIRECRAWL_HELP, 0);
    }
    const hint = `Install the Firecrawl CLI for the rest: ${INSTALL} (see /docs/sdks/cli.md)`;
    if (name !== "search" && name !== "scrape") {
      stderr.push(
        `firecrawl ${name} isn't in this hosted shell, which has search and scrape. ${hint}`,
      );
      return result("", 2);
    }
    const c: Context = {
      client,
      fs: ctx.fs,
      cwd: ctx.cwd,
      signal: ctx.signal,
      stderr,
    };
    try {
      return result(await (name === "search" ? search : scrape)(c, rest), 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Unsupported) {
        stderr.push(`Error: ${message}. ${hint}`);
        return result("", 2);
      }
      stderr.push(`Error: ${message}`);
      return result("", 1);
    }
  });
}
