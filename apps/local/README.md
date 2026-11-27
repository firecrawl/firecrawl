# Firecrawl Local

Firecrawl Local is one binary that scrapes, crawls and maps websites from your own machine. It turns pages into clean markdown, plugs into AI agents as an MCP server, and serves the Firecrawl v2 API on localhost, so code written for Firecrawl runs against it unchanged. There is no database, queue or container to run.

Pages are fetched and cleaned on your machine with the same cleaning code the Firecrawl API uses. Search, pages that refuse your machine, and Alexandria data providers go to [Firecrawl Cloud](#what-runs-where), which you can turn off.

- [Install](#install)
- [Quick start](#quick-start)
- [Add it to your AI agent](#add-it-to-your-ai-agent)
- [Run the Firecrawl API locally](#run-the-firecrawl-api-locally)
- [Command reference](#command-reference)
- [What runs where](#what-runs-where)
- [Security](#security)
- [Configuration](#configuration)
- [Limits](#limits)
- [Development](#development)

## Install

You need Rust and a C compiler. On macOS, install the Xcode command line tools with `xcode-select --install`. On Debian and Ubuntu, install `build-essential`. Then install Firecrawl Local from crates.io.

```bash
cargo install firecrawl-local
firecrawl-local --version
```

To build the latest code from this repository instead, clone it and build `apps/local`. The binary lands in `target/release/firecrawl-local`.

```bash
git clone https://github.com/firecrawl/firecrawl.git
cd firecrawl/apps/local
cargo build --release
./target/release/firecrawl-local --version
```

Two optional extras unlock more of it.

- **Chrome or Chromium.** Firecrawl Local renders pages that need JavaScript in the browser already installed on your machine. Without one, static pages still work and a page that needed a browser comes back with a warning saying so.
- **Node.js 22 or newer.** The MCP server is the `firecrawl-mcp` npm package, which Firecrawl Local runs through `npx`.

## Quick start

Scrape a page and print its markdown.

```bash
firecrawl-local scrape https://example.com --markdown
```

Crawl a site and save one markdown file per page.

```bash
firecrawl-local crawl https://docs.firecrawl.dev --limit 50 --out ./pages
```

List every URL on a site.

```bash
firecrawl-local map https://firecrawl.dev
```

Without `--markdown`, `scrape` prints the same JSON the Firecrawl API returns. Ask for more formats with `--format markdown,links` (the choices are `markdown`, `html`, `rawHtml` and `links`). PDFs and Office documents are parsed on your machine too.

## Add it to your AI agent

`init` adds Firecrawl Local as an MCP server to every AI tool it finds on your machine.

```bash
firecrawl-local init
```

It knows Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI and Codex. It backs up each config file before changing it. Add `--dry-run` to see the changes without writing them, or `--agent cursor` to set up one tool. Restart the tool afterwards so it loads the new server.

To add it by hand, register `firecrawl-local mcp` as a stdio MCP server. In a JSON config that looks like this, with the full path to the binary.

```json
{
  "mcpServers": {
    "firecrawl": {
      "command": "/path/to/firecrawl-local",
      "args": ["mcp"]
    }
  }
}
```

Your agent gets the standard Firecrawl MCP tools. `firecrawl-local mcp` starts the local API on a loopback port and runs the `firecrawl-mcp` package against it, so scrape, crawl, map and batch scrape run on your machine and the other tools go to Firecrawl Cloud.

## Run the Firecrawl API locally

`serve` answers the Firecrawl v2 API on port 3002.

```bash
firecrawl-local serve
```

From another terminal, scrape a page through it.

```bash
curl -s http://localhost:3002/v2/scrape \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
```

Point any Firecrawl SDK at it by setting its API URL to `http://localhost:3002`. No API key is needed for local routes.

```python
from firecrawl import Firecrawl

app = Firecrawl(api_url="http://localhost:3002")
print(app.scrape("https://example.com").markdown)
```

```js
import { Firecrawl } from "firecrawl";

const app = new Firecrawl({ apiUrl: "http://localhost:3002" });
const doc = await app.scrape("https://example.com");
console.log(doc.markdown);
```

These routes run on your machine.

| Route | What it does |
| --- | --- |
| `POST /v2/scrape` | Scrape one URL |
| `POST /v2/map` | List a site's URLs |
| `POST /v2/crawl`, `GET` and `DELETE /v2/crawl/{id}` | Start, check and cancel a crawl |
| `POST /v2/batch/scrape`, `GET` and `DELETE /v2/batch/scrape/{id}` | Start, check and cancel a batch scrape |
| `GET /health` | Health check |

Every other `/v2` route, such as `/v2/search`, is passed on to Firecrawl Cloud, unless `FIRECRAWL_CLOUD` says otherwise. The v0 and v1 routes are not served. Crawl and batch jobs live in memory and expire an hour after they start.

## Command reference

| Command | What it does | Runs on |
| --- | --- | --- |
| `scrape <urls...>` | Scrape one or more URLs | Your machine |
| `crawl <url>` | Follow links from a start URL | Your machine |
| `map <url>` | List a site's URLs from its sitemaps and start page | Your machine |
| `serve` | Run the Firecrawl v2 API on localhost | Your machine |
| `mcp` | Run the Firecrawl MCP server over stdio | Your machine, other tools on Firecrawl Cloud |
| `init` | Add the MCP server to the AI tools on this machine | Your machine |
| `search <query>` | Search the web | Firecrawl Cloud |
| `find-tools <query>` | Find Alexandria data providers | Firecrawl Cloud, needs sign-in |
| `data <provider> <capability>` | Run an Alexandria data provider | Firecrawl Cloud, needs sign-in |
| `login` | Sign in to Firecrawl in the browser | Firecrawl Cloud |

Run `firecrawl-local <command> --help` for every option. The ones you will reach for most are below.

- **scrape.** `--markdown` prints only the markdown, `--format` picks output formats, `--full-page` keeps navigation and footers, and `--timeout` sets the per-page limit in milliseconds.
- **crawl.** `--limit` caps the page count (default 100), `--max-depth` caps link depth, `--include` and `--exclude` take path regexes, `--entire-domain` follows links outside the start path, and `--out` writes markdown files instead of JSON.
- **map.** `--search` keeps only URLs containing some text, and `--limit` caps the count.
- **serve.** `--port` (default 3002), `--host`, `--token` and `--allow-private`, covered in [Security](#security).
- **Any command.** `--browser auto|never|always` decides when to use Chrome.

## What runs where

Scraping, crawling, mapping and document parsing run on your machine and send nothing to Firecrawl. Three things need Firecrawl Cloud because a laptop does not have the index, the network or the data.

| Feature | Why it goes to the cloud | Account needed |
| --- | --- | --- |
| Search | There is no search index on your machine | No, keyless search is rate limited |
| Pages that refuse your machine | When a site blocks both the plain fetch and the local browser, Firecrawl Cloud fetches it | No |
| Alexandria data providers | The providers run on Firecrawl Cloud | Yes, a free account |

A page Firecrawl Cloud fetched for you carries `"source": "firecrawl-cloud"`. If the cloud cannot get it either, the result has `"blocked": true` and a warning that says why. Cloud calls carry a random install ID and the name of the tool that made them, which is how Firecrawl counts installs.

To sign in, run `login`. It opens the browser and saves your API key in the same place the Firecrawl CLI keeps it, so either tool's login works for both.

```bash
firecrawl-local login
```

A running `serve` picks up the login straight away, and so do the MCP server's search and scrape tools. The MCP server's Alexandria tools check for a key when they start, so restart your AI tool after signing in to use them.

`FIRECRAWL_CLOUD` controls the hand-off.

| Value | Effect |
| --- | --- |
| `auto` (default) | Search, the blocked-page fallback and Alexandria all work |
| `search` | Only search goes to Firecrawl Cloud |
| `off` | Nothing goes to Firecrawl Cloud |

An unrecognised value counts as `off`. `login` always talks to Firecrawl, because signing in is its job.

## Security

The defaults differ between the tools you run yourself and the API server, because the API takes requests from other programs.

- **`scrape`, `crawl`, `map` and `mcp`** run for the person at the keyboard, so they can reach `localhost` and your private network. `scrape`, `crawl` and `mcp` take `--public-only` to refuse those addresses.
- **`serve`** listens on `127.0.0.1` and refuses localhost and private addresses unless you pass `--allow-private`. Binding another address with `--host` requires `--token`, and requests are checked against an allowed Host list that `--allowed-host` adds to.
- **Always refused.** Link-local and cloud metadata addresses are blocked in every mode, including after redirects and DNS resolution.

An AI agent that reads a page with hidden instructions could be steered into opening an internal URL. If your agent browses sites you do not trust, register the MCP server as `firecrawl-local mcp --public-only`.

The same rules cover the browser. Chrome runs headless and sandboxed with a throwaway profile, behind a loopback proxy inside Firecrawl Local that checks every connection it opens, including redirects, subresources, script requests and WebSockets.

Firecrawl Local identifies itself in its User-Agent and reads `robots.txt` when crawling, where site owners can address it as `FirecrawlLocal`.

### Running in Docker

Chrome keeps its sandbox on, which needs user namespaces, and Docker's default seccomp profile blocks them. To render JavaScript pages in a container, use a profile that keeps Docker's defaults and also allows `clone`, `setns` and `unshare`. Playwright publishes one.

```bash
curl -fsSLO https://raw.githubusercontent.com/microsoft/playwright/main/utils/docker/seccomp_profile.json
docker run --security-opt seccomp=seccomp_profile.json your-image
```

Do not use `seccomp=unconfined` for this. It removes the whole filter from a container that loads pages you do not control.

## Configuration

| Variable | Effect |
| --- | --- |
| `FIRECRAWL_CLOUD` | `auto`, `search` or `off`, see [What runs where](#what-runs-where) |
| `FIRECRAWL_API_KEY` | Firecrawl API key, used instead of the saved login |
| `FIRECRAWL_API_URL` | Firecrawl Cloud address |
| `FIRECRAWL_LOCAL_BROWSER` | `auto` (default), `never` or `always`, same as `--browser` |
| `FIRECRAWL_CHROME_PATH` | Path to the Chrome or Chromium to use |
| `FIRECRAWL_LOCAL_TOKEN` | Bearer token for `serve`, same as `--token` |
| `FIRECRAWL_LOCAL_ALLOW_PRIVATE` | Let `serve` callers reach private addresses, same as `--allow-private` |
| `FIRECRAWL_LOCAL_USER_AGENT` | Override the User-Agent |
| `FIRECRAWL_LOCAL_SCROLL` | Scroll rendered pages before reading them |
| `FIRECRAWL_LOCAL_HOME` | Folder for Firecrawl Local's own files, such as its install ID |
| `FIRECRAWL_CLI_CREDENTIALS` | Path of the saved login, which defaults to the Firecrawl CLI's |
| `FIRECRAWL_MCP_PACKAGE` | npm package `mcp` runs, default `firecrawl-mcp` |
| `FIRECRAWL_LOCAL_TRACE` | Print browser timing to stderr, for debugging |
| `FIRECRAWL_WEB_URL` | Site `login` opens, for testing against another deployment |

## Limits

- Local scrapes skip the `json` and `summary` formats with a warning, and ignore browser `actions`. Screenshots need Chrome.
- Crawl and batch jobs are kept in memory, so they end when `serve` stops.
- The v0 and v1 API routes are not served.

For a full Firecrawl server with queues, workers and every format, see the [self-hosting guide](https://docs.firecrawl.dev/contributing/self-host). It lives in `apps/api` and is unchanged by Firecrawl Local.

## Development

```bash
cd apps/local
cargo test
```

Firecrawl Local shares the `firecrawl-core` crate with the API and builds it without Node bindings.

### Releases

`.github/workflows/publish-local.yml` publishes the crate to crates.io when the version in `Cargo.toml` on `main` is newer than the published one, so a release is a version bump. It uses trusted publishing, and the publish step waits for approval in the `release` environment.

A crate on crates.io cannot depend on the unpublished `firecrawl-core` crate, so `scripts/vendor-native.sh` copies the shared modules into `src/native` and replaces the path dependency in place before packaging. Run the script in a disposable checkout to avoid changing normal repository builds.
