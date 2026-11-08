# @firecrawl/scraper

Thin TypeScript CLI over the self-hosted Firecrawl API at `http://localhost:3002`.

Run via `tsx` — no build step needed. Tasks live in the repo-root `taskfile.yml`.

## Quick start

```bash
task scraper:install                                  # one-time
task scraper                                          # interactive: pick everything in the terminal
task scrape -- https://example.com                    # markdown → stdout
task scrape -- https://example.com -o page.md
task scrape:batch -- --file urls.txt --out ./out/
task crawl -- https://docs.example.com --limit 50 --out ./docs/
task map -- https://example.com --limit 100
```

## Interactive wizard (`task scraper`)

`task scraper` is the one entry point for archiving and transcription. It opens a terminal wizard ([Ink](https://github.com/vadimdemedes/ink)) where every option is picked with the arrow keys, Space and Enter; Esc goes back a step and Ctrl+C quits.

1. **What do you want to do?** Archive a site · Transcribe existing files · Set up transcription.
2. **Archive a site** asks for the URL, then the **engine**: _Chrome via CDP (your logged-in browser)_ or _Firecrawl API_. Choosing CDP asks for the DevTools URL (default `http://localhost:9222`) and checks it live. When nothing answers it offers to **start a dedicated Chrome on that port** (profile `~/.scraper-chrome`, left open after the run so your logins persist), check again, or switch to the API. Then: Play-button clicking, page limit, delay, which media to download (images, video, audio), the size cap, whether to **transcribe** audio and video, how many transcription workers, the spoken language, and the output directory.
3. **Transcribe existing files** lists recent archive runs in `data/` that have audio or video, or takes a path to a media file or folder.
4. **Set up transcription** builds whisper.cpp and downloads the model (see below). Choosing transcription before it is set up offers to do this before the run starts.

A review screen lists every choice; Enter starts the run. The run shows a live dashboard: the pages bar and current URL, the active download, **one row per transcription worker** with its file and progress, counts, recent errors and the output path. Ctrl+C stops the run, keeps everything finished so far and marks it `interrupted`.

The flag-based tasks below run the same code without the wizard, for scripts. On a terminal they show the same dashboard; `--no-ui` (or redirected output) prints plain progress lines instead.

## Archive a whole site

```bash
# Chrome/CDP: uses the browser session you launched below
task scrape:all:cdp -- "https://example.com"

# Normal API: starts local Docker services automatically if needed
task scrape:all:api -- "https://example.com"

# Override the defaults
task scrape:all:cdp -- "https://example.com" --limit 25 --max-media-mb 20 --delay-ms 2000

# Audio/video that loads only after a Play click (CDP only)
task scrape:all:cdp -- "https://example.com/listening-test" --play-media
task scrape:all:api -- "https://example.com" --out ./my-archives/

# Only some media kinds, and transcribe audio/video while crawling
task scrape:all:cdp -- "https://example.com" --media audio,video --transcribe --transcribe-workers 2
```

Run `task scraper:install` once first. CDP requires Chrome launched with a dedicated profile and debugging port; see the Chrome setup below. It reuses that context's cookies. For signed-in archives, log into the target site in that same dedicated Chrome profile before running the command; sessions in another Chrome profile are separate. Set a profile `waitFor` value for pages that load account data after navigation. Each shortcut explicitly selects its engine, regardless of profile/domain engine settings; unavailable CDP never falls back to the API. API startup applies only to local HTTP endpoints and leaves the services running; stop them with `task down`. Its progress and Docker Compose output appear in the dashboard's Setup row, or as indented lines with `--no-ui`. Remote API endpoints must already be available.

Results go into the checkout's `data/` directory, even when Task is invoked from a subdirectory. In the main checkout, that is `/home/rdisckyzp/repos/firescrape/data/`. An explicit `--out` selects a different archive root and resolves relative to your invocation directory.

```text
data/<hostname>/<UTC-timestamp>-<unique-id>/
├── index.md                 # Browse pages, files, media and failures
├── manifest.json            # Engine, settings, status and all results
├── pages/<URL-path>--<hash>/
│   ├── content.md
│   ├── page.html
│   ├── raw.html
│   ├── page.json            # Metadata, links and media references
│   └── screenshot.png       # CDP only, when capture succeeds
├── assets/
│   ├── images/
│   ├── audio/
│   └── videos/
└── transcripts/             # With transcription: <media name>--<hash>.{txt,srt,vtt,json}
```

The command prints the absolute output directory and `index.md` location. Without the dashboard (`--no-ui` or redirected output), media progress on stderr shows each item’s count, current file, bytes transferred, percentage when the server supplies a usable size, and elapsed seconds. A one-second heartbeat continues while waiting for a response or retrying, and each item ends with downloaded/reused/skipped/failed status. Interactive terminals update the current line; redirected output gets plain progress lines. Query strings are excluded from progress labels. `data/*` is gitignored. Runs never overwrite each other; URL hashes distinguish query variants, and shared media downloads once per run. These are content archives, not offline replicas: HTML keeps its original resource links, while `page.json` maps discovered assets to local files.

Defaults are **100 attempted pages**, **100 MB per media file** (decimal MB), and a **1,000 ms gap between pages**, processed sequentially. The size cap applies to each file. Use `--limit`, `--max-media-mb`, and `--delay-ms` to change these. `--media image,video,audio` limits which kinds are downloaded (all three by default); the others are listed in the manifest as skipped. Direct CLI usage is `pnpm exec tsx src/cli.ts archive URL --engine cdp` (CDP is its default).

The archive follows accessible same-origin links, including navigation links, and skips obvious logout/action URLs and non-page files. An initial redirect establishes the origin; later redirects outside it are recorded without expanding them. It does not execute configured profile `actions`, submit forms, discover unlinked pages, automatically scroll, or solve CAPTCHAs. Archive formats and `onlyMainContent: false` are fixed so text-format profile settings cannot hide media or navigation.

Images include lazy-loading/responsive sources and posters. Audio comes from `<audio>`/`<source>` elements, audio file links and `og:audio`. In CDP mode, audio and video files the page loads while it is open are added too, even when their URLs never appear in the HTML. Videos and audio must expose direct file URLs; streaming manifests and embedded players remain references.

Some pages request their media only after a Play click. `--play-media` (CDP only) clicks up to three visible controls named like Play/Listen (or with a "play" `aria-label`), waits up to 10 seconds for media requests, then pauses playback before capturing. Clicking is a real interaction: it can start a timed test or trigger other site actions, and audio may be heard briefly. Pages without a matching control are saved with a warning. Downloads use destination-scoped browser cookies in CDP mode, but the media transfer uses Node HTTP rather than Chrome's network stack and can still be blocked. CDP does not guarantee undetectable automation.

Every CDP scrape waits for page network activity to be idle for 500 ms before capturing content, then requests below-fold lazy images and waits for images/fonts to finish. Screenshots disable animations. Readiness has a 30-second default budget (or the profile `timeout`); polling/streaming pages that never settle are captured with a warning and `metadata.captureReady: false`. This applies to `scrape`, `batch`, and `archive`, and only waits on the scraper's page, not unrelated browser tabs. The existing profile `waitFor` adds a minimum delay before this readiness check. Network inactivity cannot guarantee that every app has finished rendering; use additional `waitFor` for delayed client-side UI.

Successful pages survive individual failures. `manifest.json` and `index.md` record failed pages/downloads, skipped oversized files, unsupported players, and screenshot warnings. Page/download failures exit nonzero; reaching limits or skipping unsupported/oversized media is normal completion. Ctrl-C preserves the completed work and removes partial media files.

## Audio and video transcription

Downloaded audio and video can be transcribed to text **with timestamps** by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) running locally on the GPU. With `--transcribe` (or "Transcribe: yes" in the wizard), each audio or video file is queued as soon as it is downloaded, and N workers transcribe while the crawl continues; the run ends once every queued file is done.

**Setup** happens in the app: `task scraper` → _Set up transcription_. It clones whisper.cpp v1.9.5 into `~/.local/share/firescrape/whisper.cpp`, builds `whisper-cli` with CUDA for the local GPU (a CPU build when `nvcc` is missing), and downloads `ggml-large-v3-turbo-q5_0.bin` (about 550 MB) to `~/.local/share/firescrape/models/`. It needs `git`, `cmake` (for example `uv tool install cmake`) and a C++ compiler, plus `ffmpeg` on `PATH` for decoding. Rerunning it is quick: the checkout and model are reused and the build is incremental.

Each transcript is written in four formats next to each other:

| File    | Contents                                                                                     |
| ------- | -------------------------------------------------------------------------------------------- |
| `.txt`  | One segment per line: `[00:01:23.450 → 00:01:27.900] text`                                   |
| `.srt`  | SubRip subtitles                                                                             |
| `.vtt`  | WebVTT subtitles                                                                             |
| `.json` | whisper.cpp's full JSON: segments with millisecond offsets, tokens and the detected language |

In an archive they go to `transcripts/`, and `manifest.json` (`transcripts[]`: status, files, language, duration, segment count) and `index.md` list them. A failed transcription marks the run `partial`.

**Workers.** Each worker is its own `whisper-cli` process with its own copy of the model (about 1 GB of GPU memory for the default model), so 2 workers transcribe two files at once; the CPU threads are split between workers. Default 2.

**Past runs and other files.** `transcribe <paths...>` takes archive run directories (updating their manifest and index), media files (transcripts are written next to each file) or folders (searched recursively). Files that already have a `.txt` transcript are skipped, so it can be rerun after an interruption.

```bash
pnpm exec tsx src/cli.ts transcribe ../../../data/example.com/2026-11-08T09-05-20-197Z-HkayYJ
pnpm exec tsx src/cli.ts transcribe ~/Podcasts --transcribe-workers 3 --language en
```

Overrides: `transcribe.whisperBin` and `transcribe.model` in `scraper.config.yaml`, the `WHISPER_CLI` environment variable for the binary, `FIRESCRAPE_WHISPER_HOME` for the install location, and `--whisper-model <path>` / `--cpu` per run.

Downloaded media is untrusted input, so ffmpeg only opens it as an ordinary local audio/video file: playlist formats such as HLS or ffconcat saved under a media extension are refused.

## Commands

| Command                 | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `scrape <url>`          | Single URL → one document                                   |
| `batch [urls...]`       | Many URLs (args, `--file`, or `--stdin`) → many documents   |
| `crawl <url>`           | Start a crawl, poll `/v1/crawl/:id`, stream results         |
| `archive <url>`         | Archive linked pages and discovered image/audio/video files |
| `transcribe <paths...>` | Transcribe archive runs, media files or folders             |
| `map <url>`             | List URLs reachable on a site (no scraping)                 |

With no command (and a terminal), the CLI opens the interactive wizard.

### Global options

| Flag                  | Default               | Description                                    |
| --------------------- | --------------------- | ---------------------------------------------- |
| `-c, --config <path>` | `scraper.config.yaml` | YAML config file                               |
| `--api-url <url>`     | from config           | Override API base URL                          |
| `--profile <name>`    | `default`             | Named profile from config                      |
| `-f, --format <name>` | `markdown`            | `markdown` \| `html` \| `json` \| `screenshot` |

### Per-command options

- **scrape / batch / crawl / map** support `-o, --out <path>`:
  - `-` or omitted → stdout
  - path with extension → single file (results concatenated for batch)
  - path ending `/` or no extension → directory, one file per URL (`<host>/<path>.<ext>`)
- **batch**: `--file <path>`, `--stdin`, `--concurrency <n>`, `--resume`, `--no-progress`
- **crawl**: `--limit`, `--max-depth`, `--include-paths`, `--exclude-paths`, `--poll-ms`, `--no-progress`
- **map**: `--search`, `--limit`, `--ignore-sitemap`, `--include-subdomains`
- **archive**: `-o, --out`, `--limit`, `--max-media-mb`, `--delay-ms`, `--play-media`, `--media <kinds>`, `--transcribe`, `--no-ui`, and the transcription options below
- **transcribe**: `--no-ui` and the transcription options:
  - `--transcribe-workers <n>` (default 2) whisper processes running at once
  - `--language <code>` (default `auto`) spoken language, e.g. `en`, `id`
  - `--whisper-model <path>` a different ggml model file
  - `--cpu` transcribe on the CPU

## Output formats

| Format       | Ext     | Notes                                                        |
| ------------ | ------- | ------------------------------------------------------------ |
| `markdown`   | `.md`   | Default; cleanest for LLM workflows                          |
| `html`       | `.html` | Cleaned HTML (falls back to rawHtml)                         |
| `json`       | `.json` | Full Firecrawl response (markdown + html + links + metadata) |
| `screenshot` | `.png`  | Self-hosted API can't do this; **works with `--engine cdp`** |

## Config (`scraper.config.yaml`)

See `scraper.config.example.yaml`. Loaded from CWD (or `--config <path>`); zod-validated; `${ENV_VAR}` interpolation.

```yaml
apiUrl: http://localhost:3002
concurrency: 5
retries: { attempts: 3, initialDelayMs: 500 }

profiles:
  default: { formats: [markdown], onlyMainContent: true }
  docs: { excludeTags: [nav, footer, ".sidebar"] }
  with-shot: { formats: [markdown, screenshot], waitFor: 2000 }

domains:
  "example.com":
    headers:
      Cookie: "${EXAMPLE_COOKIE}"
  "*.docs.io":
    waitFor: 3000

# Optional: a whisper.cpp binary and model other than the in-app install
transcribe:
  whisperBin: /opt/whisper.cpp/build/bin/whisper-cli
  model: /opt/models/ggml-large-v3.bin
```

**Merge order** (later wins): `default` profile → selected `--profile` → matched `domains.<host>` → CLI flags.

## Engines

Two backends, picked per request. The default `api` engine forwards to your self-hosted Firecrawl. The `cdp` engine drives **your real Chrome** via the DevTools Protocol — it's the same browser you read articles in, so it can reuse your existing sessions; sites can still detect automation.

Both engines use the same HTML→markdown converter (`turndown` — the same library Firecrawl itself ships in `apps/api`). The `cdp` engine adds a Firecrawl-style preprocessing pass: strips `script`/`style`/`nav`/`footer`/ads/modals/cookie banners, removes inline event handlers and `style` attrs, and (when `onlyMainContent: true`) runs Mozilla Readability for article extraction.

| Engine          | When to use                                                            | Limitations                                                                                                    |
| --------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `api` (default) | Public sites, sites without strong bot defense                         | Vanilla Playwright fingerprint; loses to Cloudflare/Akamai                                                     |
| `cdp`           | Paywalled sites you're logged into; sites that block headless Chromium | `scrape`, `batch` and `archive` (no API `crawl`/`map`); requires Chrome running with `--remote-debugging-port` |

**Resolution order** (winner takes all): `--engine` flag → `domains.<host>.engine` in YAML → `profiles.<name>.engine` → default `api`.

## Scraping subscription / paywalled sites

Only for sites you have a legitimate subscription to. Pick one of three approaches in increasing order of robustness:

### A. CDP — drive your real Chrome (most robust)

Launch a dedicated Chrome instance with a CDP port open, log into your subscription **once** in that window, then point the scraper at it. This reuses your browser session; sites can still detect automation.

**Shortcut (Linux/macOS):** `task scraper:chrome` starts it with the flags below (logs go to `~/.scraper-chrome/chrome.log`), waits until the port answers, and does nothing if Chrome is already listening. Use `CDP_PORT=9333` for another port.

**One-time setup (Linux):**

```bash
mkdir -p "$HOME/.scraper-chrome"
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.scraper-chrome" &

# In that Chrome window, log in to NYT / FT / Substack / etc.
# Subscriptions persist in this profile across runs.
```

**One-time setup (macOS):**

```bash
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.scraper-chrome"
```

**Verify the port is open:**

```bash
curl -s http://localhost:9222/json/version | jq .Browser
```

**Scrape:**

```bash
# explicit per-call
task scrape -- https://www.nytimes.com/... --engine cdp

# or set a per-domain override in scraper.config.yaml:
#   domains:
#     "www.nytimes.com":
#       engine: cdp
# then just:
task scrape -- https://www.nytimes.com/...
```

`screenshot` format works on the CDP engine (it didn't on the API engine because self-hosted Firecrawl has no screenshot-capable engine).

**Important: use a separate `--user-data-dir`.** Don't point CDP at your daily-driver Chrome profile — anything connecting to the port has full access to every session you have.

### B. Cookie injection (fastest, less robust)

1. Log in via your browser → DevTools → Network → copy the `Cookie` header from any authenticated request.
2. Export the value to your shell (don't commit cookies to YAML):
   ```bash
   export NYT_COOKIE="..."
   ```
3. Add a per-domain override in `scraper.config.yaml`:
   ```yaml
   domains:
     "www.nytimes.com":
       headers:
         Cookie: "${NYT_COOKIE}"
         User-Agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
       waitFor: 2000
   ```
4. Scrape:
   ```bash
   task scrape -- https://www.nytimes.com/2026/01/15/some-article.html
   ```

The `Cookie` header is forwarded by the API to the underlying Playwright fetch, so the page renders as if you were logged in.

### C. Scripted login (when cookies rotate or are bound to IP)

Add an `actions` array to a profile — the API will navigate, type, click, then scrape:

```yaml
profiles:
  my-site-login:
    waitFor: 1500
    actions:
      - { type: write, selector: "#email", text: "${MY_EMAIL}" }
      - { type: write, selector: "#password", text: "${MY_PASSWORD}" }
      - { type: click, selector: "button[type=submit]" }
      - { type: wait, milliseconds: 2000 }
      - { type: scrape }
```

Then: `task scrape -- https://my-site.com/dashboard --profile my-site-login`.

### Caveats

- **Don't commit secrets.** Always use `${ENV_VAR}` in the YAML; the `scraper.config.yaml` is gitignored, but env vars are still safer.
- **Sessions expire.** Refresh `Cookie` when scrapes start returning login pages.
- **Anti-bot still bites.** A valid cookie doesn't beat Cloudflare/Akamai TLS fingerprinting. Self-hosted has no fire-engine, so heavily defended sites may 403 even logged in. Add a residential `PROXY_SERVER` in the API's `.env` if needed.
- **ToS.** Scraping a site you have access to is not the same as being allowed to scrape it. Read the Terms.

## Features

- **Retries** — 5xx, 408, 429, network errors. Exponential backoff. Honors `Retry-After`.
- **Resume** — `.scraper-state/<hash>.json` tracks completed/failed URLs. `--resume` skips done.
- **Per-domain overrides** — cookies, headers, wait times scoped to host (glob match).
- **Progress bar** — `cli-progress` on stderr; auto-off when output is stdout or stderr is non-TTY.
- **Concurrency** — `p-limit` on batches; default 5.

## Limitations

- **Self-hosted API has no fire-engine.** Screenshot, Cloudflare bypass, etc. are cloud-only on the `api` engine. Use `--engine cdp` (your real Chrome) when you hit a wall.
- **CDP crawling uses the archive command.** `task scrape:all:cdp` follows site links through Chrome. Existing `crawl` and `map` commands still use the API.
- **No auth on the local API.** Assumes the API has `USE_DB_AUTHENTICATION=false` (self-host default).
- **Sequential awaits in retry / crawl-poll loops** are intentional (each iteration depends on the previous result). The 8 `no-await-in-loop` lint hints are warnings, not errors.

## Extending

Each pluggable surface is a single file in its directory:

| Add a...      | Drop a file in... | Then register in...                             |
| ------------- | ----------------- | ----------------------------------------------- |
| Format        | `src/formats/`    | `src/formats/index.ts`                          |
| Input source  | `src/inputs/`     | wire into `src/cli.ts`                          |
| Output writer | `src/outputs/`    | wire into `src/outputs/index.ts` (`pickOutput`) |

Interfaces: `Format`, `InputSource`, `OutputWriter` (in each dir's `types.ts`).

## Toolchain

| Tool               | Purpose                                                 |
| ------------------ | ------------------------------------------------------- |
| `tsx`              | Run TS directly                                         |
| `tsdown`           | Optional bundle (`task scraper:build` → `dist/cli.mjs`) |
| `tsgo`             | Typecheck (`task scraper:typecheck`)                    |
| `oxlint` / `oxfmt` | Lint + format (Rust-based)                              |
| `vitest`           | Tests                                                   |
| `ink` / `react`    | Terminal wizard and dashboard (`src/ui/`)               |

All deps pinned exact (no `^`/`~`).

CI runs typecheck + lint + tests + build on every push or PR that touches `apps/cli/scraper/**` (`.github/workflows/scraper-ci.yml`).
