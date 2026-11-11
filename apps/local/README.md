# Firecrawl Local

A single Rust binary that scrapes, crawls and maps the web from your own machine. It speaks the Firecrawl v2 API, plugs into AI agents through the Firecrawl MCP server, and needs no database, queue or container.

It shares its HTML cleaning code with the Firecrawl API. Firecrawl Local compiles `apps/api/native/src` directly, so a page cleaned locally and a page cleaned in the cloud go through the same rules.

## Build

```sh
cd apps/local
cargo build --release
./target/release/firecrawl-local --help
```

Pages that need JavaScript are rendered in the Chrome or Chromium already installed on the machine. Without one it still handles static pages. Set `FIRECRAWL_CHROME_PATH` to point it at a specific browser.

## Use it from the command line

```sh
firecrawl-local scrape https://example.com --markdown
firecrawl-local crawl https://docs.example.com --limit 200 --out ./pages
firecrawl-local map https://example.com
```

`scrape` returns the same JSON shape as the Firecrawl API. `--format` takes `markdown`, `html`, `rawHtml` and `links`, and `--full-page` keeps navigation and footers. PDFs and office documents are parsed locally.

## Use it from an AI agent

```sh
firecrawl-local init
```

`init` adds Firecrawl Local as an MCP server to the AI coding tools it finds on the machine (Claude Code, Claude desktop, Cursor, Windsurf, Gemini CLI and Codex). It backs up each config file before changing it, and `--dry-run` shows the change without writing it. To wire it up by hand, run `firecrawl-local mcp` as a stdio MCP server.

Firecrawl Local does not carry an MCP server of its own. `firecrawl-local mcp` starts its API on a loopback port and runs the [Firecrawl MCP server](https://github.com/firecrawl/firecrawl-mcp-server) against it, so the tools, their descriptions and their updates are the same ones every other Firecrawl MCP user gets. Scrape, map, crawl and batch scrape are answered on your machine, and the other tools are passed on to Firecrawl cloud. It needs Node.js 22 or newer, because the MCP server is the `firecrawl-mcp` package run through `npx`.

## Use it as a local API

```sh
firecrawl-local serve --port 3002
curl -s localhost:3002/v2/scrape -H 'content-type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
```

`serve` answers `/v2/scrape`, `/v2/map`, `/v2/crawl` and `/v2/batch/scrape`, so existing Firecrawl SDKs work when pointed at it. The older v0 and v1 routes are not served. Crawl and batch jobs are kept in memory and expire an hour after they are created.

Every other `/v2` route, such as `/search`, `/agent` and data providers, is passed on to Firecrawl cloud when a key or `FIRECRAWL_CLOUD` is set, and answers `CLOUD_ONLY` otherwise. Structured JSON output and browser actions on a local scrape are not implemented. The full self-hosted server in `apps/api` is unchanged.

## What runs locally and what runs on Firecrawl cloud

Scrape, crawl, map and document parsing run on your machine and send nothing to Firecrawl.

Everything else uses Firecrawl cloud, because it needs an index, data or a service the machine does not have. The three you will meet most are these.

- **Search.** `firecrawl-local search` and the MCP server's `firecrawl_search` tool query Firecrawl's search.
- **Pages that will not load locally.** When a site refuses a plain fetch and the local browser, the CLI and MCP server ask Firecrawl cloud for the page and mark the result with `source: firecrawl-cloud`.
- **Alexandria data providers.** `find-tools` and `data` reach structured data providers and need a Firecrawl account.

`firecrawl-local login` signs in through the browser and saves the key where the Firecrawl CLI keeps it. Set `FIRECRAWL_CLOUD=off` to turn off search, the cloud fallback and data providers, or `FIRECRAWL_CLOUD=search` to allow search only. `login` always talks to Firecrawl, since signing in is its whole job. `serve` stays local unless a key or `FIRECRAWL_CLOUD` is set.

## Safety defaults

- `serve` listens on `127.0.0.1`. Binding any other address requires `--token`, and requests are checked against an allowed `Host` list.
- `serve` callers cannot reach localhost or private networks unless `--allow-private` is set. The command line and the MCP server run for the person at the keyboard, so they allow local and private targets by default; pass `--public-only` to refuse them there too.
- Because the command line and the MCP server can reach local and private addresses, an AI agent that follows instructions hidden in a page could be steered into reading an internal page. If the agent browses sites you do not trust, register the MCP server as `firecrawl-local mcp --public-only`.
- Link-local and cloud metadata addresses are refused in every mode, including after redirects and DNS resolution.
- The same rules cover the browser. Chrome runs behind a loopback proxy inside Firecrawl Local that checks every connection it opens, including redirects, subresources, scripts' own requests and WebSockets. With private targets off, a public page cannot make the browser call a private address. With them on, as in the command line's default, a page the browser loads can reach the local network the way it could in your own browser.
- The local browser runs headless and sandboxed with a throwaway profile.
- It identifies itself in its User-Agent and reads `robots.txt` when crawling.

## Environment variables

| Variable | Effect |
| --- | --- |
| `FIRECRAWL_LOCAL_BROWSER` | `auto` (default), `never` or `always` |
| `FIRECRAWL_CHROME_PATH` | Path to the Chrome or Chromium to use |
| `FIRECRAWL_CLOUD` | `auto`, `search` or `off` |
| `FIRECRAWL_API_KEY`, `FIRECRAWL_API_URL` | Firecrawl cloud key and address |
| `FIRECRAWL_LOCAL_TOKEN` | Bearer token for `serve` |
| `FIRECRAWL_LOCAL_ALLOW_PRIVATE` | Let `serve` callers reach private addresses |
| `FIRECRAWL_LOCAL_USER_AGENT` | Override the User-Agent |
| `FIRECRAWL_LOCAL_SCROLL` | Scroll rendered pages before reading them |
| `FIRECRAWL_LOCAL_TRACE` | Print browser settle timing to stderr |
| `FIRECRAWL_LOCAL_HOME` | Folder for Firecrawl Local's own files, such as its install ID |
| `FIRECRAWL_CLI_CREDENTIALS` | Path of the saved login file, which defaults to the Firecrawl CLI's |
| `FIRECRAWL_WEB_URL` | Address of the site `login` opens, for testing against another deployment |
| `FIRECRAWL_MCP_PACKAGE` | The npm package `mcp` runs, which defaults to `firecrawl-mcp` |

## Tests

```sh
cargo test
```
