# Scraper benchmark

A local benchmark for engines that expose the Firecrawl scrape API
(`POST /v1/scrape {"url", "formats": ["markdown"], "onlyMainContent": true}`).
It measures speed, memory and markdown quality on a fixed corpus served from localhost, and
success in the wild on a list of live URLs. Ground truth comes from each page's source HTML,
never from any engine's output.

Everything is Node 24 or Python 3.9 standard library. Nothing to install.

## Reproduce in three commands

```sh
# 1. Once: snapshot the corpus and derive truth (pages go to bench/.work, which is git-ignored)
node bench/corpus/fetch.mjs && python3 bench/corpus/gen_truth.py

# 2. Per engine, with the engine already listening (static suite: c=1, 8, 32 x 3 repeats)
node bench/run.mjs --engine firecrawl-engine --base-url http://127.0.0.1:3912 --corpus static --suite --pid <engine pid>

# 3. Score every engine's saved markdown and write bench/results/REPORT.md
node bench/report.mjs
```

Live run for the same engine (one pass, concurrency 4, then step 3 again):

```sh
node bench/run.mjs --engine firecrawl-engine --base-url http://127.0.0.1:3912 --corpus live --concurrency 4 --repeat 1 --pid <engine pid>
```

`run.mjs` starts the corpus server (`bench/serve.mjs`, port 3900) itself if nothing is listening
there and stops it afterwards. For an engine in a container, give the address the container
can reach and a memory sampler that prints KB:

```sh
node bench/run.mjs --engine firecrawl-selfhost --base-url http://127.0.0.1:3002 --corpus static --suite \
  --static-base http://host.docker.internal:3900 --rss-cmd "<command that prints the container's memory in KB>"
```

Other runner flags: `--concurrency n --repeat n` (instead of `--suite`), `--token <bearer>`,
`--out <file>`, `--limit n` (seeded sample of the corpus, for slow engines), `--timeout-ms`
(default 60000), `--seed` (default 42), `--settle-s` (default 10), `--no-warmup`,
`--no-cache-bust`, `--no-serve`, `--body-extra '<json merged into the request body>'`.

Step 1 refetches only what is not in `bench/.work/corpus/cache`. On a machine without that
cache the pages will have changed since the committed truth was generated, so always run
`gen_truth.py` after `fetch.mjs`; `manifest.json` records the sha256 of every snapshot.

## Files

| Path | What it is |
| --- | --- |
| `corpus/static-sources.json` | URLs of the static corpus, by category |
| `corpus/fetch.mjs` | Snapshots them: plain GET as `firecrawl-bench/0.1`, one request per host at a time, robots.txt honoured, 15 s timeout |
| `corpus/manifest.json` | id, source URL, category, bytes, fetched_at, sha256 for every page |
| `corpus/gen_truth.py` | Truth generator (source HTML only) |
| `corpus/truth/NNNN.json` | Truth per page |
| `corpus/live.json`, `corpus/build_live.py`, `corpus/live-candidates.json` | Live corpus and how it was verified |
| `serve.mjs` | Corpus server, `/p/NNNN.html` |
| `run.mjs` | Runner |
| `score.mjs`, `lib/normalize.mjs` | Scorer and the text normaliser |
| `report.mjs` | Writes `results/REPORT.md` |
| `heldout-sample.mjs`, `heldout.mjs` | Held-out check on Firecrawl's public scrape dataset |
| `run-all.sh` | Starts each engine in turn and runs a corpus through it |
| `build-linux.sh`, `engine-image/` | Linux build of the engine and the image it runs in |
| `selfhost/docker-compose.yaml` | Today's self-hosted server from its published images |
| `docker-rss.sh` | Memory sampler for engines that run in containers |
| `.work/` | Snapshots, engine outputs (`.work/out/<engine>/<id>.md`), scratch. Not committed |

## Static corpus

216 pages, 99.7 MB of HTML, from 113 hosts plus the repo's own test site. 87 pages are over
300 KB of HTML; 15 are under 10 KB.

| Category | Pages | Median HTML | What is in it |
| --- | ---: | ---: | --- |
| docs | 36 | 174 KB | Python, MDN, Rust book, Kubernetes, Postgres, Django, Vue, Svelte, Tailwind, Go (3 each), plus Node, SQLite, Git, Docker, React, TypeScript |
| blog | 22 | 169 KB | Cloudflare, GitHub, Stripe, Meta, Slack, Dropbox, Fly, Figma, Discord and personal engineering blogs |
| article | 16 | 234 KB | Guardian, BBC, Quanta, ProPublica, Nature, MIT Technology Review, IEEE Spectrum, essays, Stanford Encyclopedia, RFC 2616 |
| wikipedia | 20 | 1,133 KB | 14 language editions: en, simple, de, fr, es, pt, ja, zh, ru, ar, hi, ko, he, el, th |
| github | 13 | 315 KB | Repository pages with a rendered README |
| forum | 9 | 72 KB | Hacker News threads (two over 2 MB) and front page, Discourse threads, a Debian mail archive |
| product | 21 | 454 KB | Pricing and product pages |
| tables | 16 | 415 KB | Wikipedia lists, IANA registry, HTML entity table, type tables in docs |
| code | 17 | 115 KB | Pages dense with `<pre>`: Rust std, Go by Example, Learn X in Y, Flask, pandas, Crafting Interpreters |
| long | 14 | 926 KB | Specs, manuals and changelogs up to 4.4 MB |
| tiny | 11 | 8 KB | example.com, httpbin, single-paragraph pages |
| test-site | 21 | 14 KB | `apps/test-site`, built with Astro |

The list is in `corpus/static-sources.json`. 22 candidates were skipped at snapshot time
(robots.txt disallow or unreachable robots.txt: 9; HTTP 403: 5; HTTP 404: 8).

The server sends `content-type: text/html; charset=utf-8` and keeps connections alive (4
worker processes, pages held in memory). Pages that were not UTF-8 are transcoded at snapshot
time and their `<meta charset>` rewritten to match; nothing else in the HTML is touched.

Every page is served with a Content-Security-Policy that blocks scripts and subresources
(`--no-csp` turns it off). A snapshot's scripts point at the original site, so letting a
browser run them would make results depend on the network and on third-party servers, and
could change the DOM away from the HTML the truth was derived from. With the policy on, a
browser engine and a fetch-only engine see the same document.

The repo's Astro test site (`apps/test-site`) builds cleanly with `npm install && npx astro build`
in a copy under `bench/.work/test-site`; its 21 content pages are in the corpus as category
`test-site` (the client-redirect and robots fixtures are left out).

## Ground truth

`gen_truth.py` parses the source HTML into a tree (Python's `html.parser` tokenizer plus the
HTML rules for implied end tags), finds the main content container, and picks snippets from it.

**Main container.** In order: `<main>` or `role=main` (the largest), narrowed to a single
`<article>` if it holds most of the text; a single dominant `<article>`; otherwise walk down
from `<body>` while one child holds at least 70% of the content text. Two site hints are
hard-coded where `<main>` wraps much more than the document: MediaWiki's `#mw-content-text`
and GitHub's `article.markdown-body`.

**must_contain** (2 to 6 per page, 4 or more on 96% of pages), each an exact run of source text:

- `heading`: the `<h1>` that matches `<title>`, else the first `<h1>` in the container, else the
  longest `<title>` segment that occurs in the main text, else the first `<h2>`.
- `early`, `mid`, `late`: the first 6 to 12 words of a sentence from the first, middle and last
  prose block. Prose blocks are taken from the prose core (walk down from the container while
  one child holds 80% of the prose), so author bios, comment policies and newsletter promos at
  the end of `<main>` are not picked.
- `table_row`: two or three adjacent cells from a row in the middle of the largest data table.
- `code_line`: one line from a `<pre>` in the middle of the page.
- `extra`, `pre_line`: top-ups for pages with no heading, table or code, and for pages whose
  text lives in `<pre>` (RFCs, mail archives) or in short fragments (pricing cards).

A snippet is rejected if it spans anything converters render differently: hidden or
`aria-hidden` text, `<sup>`/`<sub>`, image alt text, buttons, tooltips, `<abbr>`, `<del>`,
`<time>`, math, permalink anchors. Also rejected: text with markup characters
(`<>[]{}|\`*_~^#=$@&+%/`), URLs, symbols, control and zero-width characters, soft hyphens,
unbalanced brackets or quotes. Prose snippets must occur exactly once in the main text and
nowhere outside it.

**must_not_contain** (0 to 3 per page): a short run of text from the primary `<nav>`, from a
cookie or consent banner, and from the footer (the copyright line where there is one). Only
elements outside `<main>` and outside the container count; a table of contents, breadcrumbs
or a pager inside the content are never used. A snippet is dropped if its text also occurs
anywhere in the main content. 31 pages have no usable boilerplate and no noise score.

**structure**: counts of `h1`–`h3`, data tables with their row counts, `<pre>` blocks, list
items and links. Headings, list items and links are counted inside the prose core; tables and
code blocks inside the content core (same walk, 80% of all visible main text). Layout tables
are not counted: nested tables, tables holding `<pre>`, code-line tables, tables with layout
attributes and no `<th>`.

`node bench/score.mjs --selfcheck` checks, with the scorer's own normaliser, that every
must_contain is in the source's main text and every must_not_contain is in the page but not
in the main text. It also scores two calibration outputs: the source's main text (must give
recall 1, noise 0) and the whole page text (must give recall 1, noise 1).

## Scoring

Both sides, truth snippet and engine markdown, go through the same normaliser
(`lib/normalize.mjs`): NFKC; undo markdown backslash escapes; decode `&amp; &lt; &gt; &quot;
&#39; &nbsp;` and numeric entities; drop images; reduce `[text](url)` and `[text][ref]` to
`text`; remove common inline HTML tags; lowercase; then delete every character that is not a
letter, digit or combining mark. A snippet is found if the result is a substring of the
normalised markdown. So whitespace, line breaks, emphasis markers, list bullets, table pipes,
smart quotes and punctuation never decide a match.

Per page:

- **recall**: share of must_contain found.
- **noise**: share of must_not_contain found (lower is better; empty when the page has none).
- **structure**: for each of headings, table rows, code blocks and list items that the source
  has, `min(1, count in markdown / count in source)`, averaged. Markdown counts: ATX and setext
  headings, table rows (`|...|`, minus separator rows), fenced blocks, list items, plus any
  raw `<tr>`, `<pre>`, `<li>`, `<h1-6>` left in the output.
- **chars**, **tokens** (chars / 4).
- **perfect**: recall 1 and noise 0. **failure**: recall below 0.5. A page with no output has recall 0.

Per engine and per category: mean and median recall, mean noise, mean structure, share
perfect, share failed, median tokens.

Speed and memory, from `run.mjs`: one warm-up pass, then the measured passes; URL order
shuffled with a fixed seed per pass; 60 s timeout per request. Pages per second counts
successful pages over wall time. p50, p95 and p99 are per-request latency of successful
requests. Each measured pass uses its own query string (`?r=<pass>`) so an engine cannot
answer from a cache. With `--pid`, the runner sums RSS over the process and all its
descendants with `ps` every 250 ms: idle RSS is the median of 8 samples after a 10 s settle,
before any request; peak RSS is the maximum during load. `--rss-cmd` replaces the sampler.
The suite reports the median of 3 passes at each of c=1, 8 and 32. Markdown is saved from the
first measured pass of the first level (c=1 in a suite).

## Live corpus

`corpus/live.json`: 119 public URLs, each with 2 or 3 `must_contain` snippets that were on the
page when the list was built (2026-11-10). A page counts as "content ok" when 2 of its 3
snippets are in the markdown, so success means the content is there, not HTTP 200.

| Group | URLs | How the snippets were verified |
| --- | ---: | --- |
| static HTML | 75 | A stratified sample of the static corpus's source URLs (12 docs, 9 wikipedia, 8 blog, 8 product, 7 article, 6 each github, tables, code, 5 forum, 4 long, 4 tiny). Snippets are the heading, early and mid snippets of that day's snapshot |
| `js: true` | 29 | Loaded twice: plain GET and the locally installed Chrome in headless mode (`--dump-dom`). Kept only snippets that are in the rendered DOM and not in the plain-GET text, so the page cannot pass without JavaScript. Client-rendered docs (Apple DocC, DevDocs, Docsify, Elm packages, Material 3, Go tour), Swagger UI and Redoc, crates.io, Open VSX, test SPAs, one client-side redirect |
| `hard: true` | 15 | Pages that answered the benchmark's plain GET with 401/403/202 or an empty shell (Stack Overflow, npm, IMDb, Medium, Quora, Trustpilot, Google Scholar, Raspberry Pi, Figma community). Snippets come from the Chrome-rendered DOM |

`score.mjs` reports `hard` pages in their own bucket; they are never counted in the main
content-ok, error or wrong-content rates. `build_live.py` reruns the verification;
`live-candidates.json` lists the candidates and the 15 that were removed after review, with
the reason (Chrome itself got a challenge or error page, or the page is a listing whose text
changes hourly). Chrome is used here as a browser to look at the page. No scraper output is read.

The live run has no warm-up pass, so each site is requested once per measured pass. Live
pages drift: rebuild the list before a run that matters, and expect a few snippets to go
stale within days on pages with user comments or search results.

## Fairness caveats

- **Localhost favours engines without politeness.** Every page comes from one host with no
  latency, no TLS and no rate limit. An engine with per-host delays, robots.txt fetches or a
  per-domain concurrency cap pays for them here and gains nothing. `serve.mjs --delay-ms n`
  adds a fixed delay per response if you want to see how the ranking moves.
- **No JavaScript on the static corpus.** The CSP makes the snapshot the whole truth. An
  engine that always launches a browser pays that cost without a quality benefit; an engine
  that decides per page is rewarded for deciding "no browser". The live corpus is where
  rendering is tested.
- **The truth generator has opinions.** It defines main content as `<main>`/`<article>`/the
  densest block. An engine with a different, defensible idea of main content (keeping a
  byline, dropping a reference list) is only scored on text deep inside the content and on
  navigation, cookie and footer text clearly outside it; sidebars, tables of contents,
  breadcrumbs and related-post grids are not scored either way. Snippets are sentence starts
  in ordinary prose, so they say little about formulas, footnotes, captions or image alt text.
- **Recall is a sample.** 4 to 6 snippets per page detect a missing article or a missing
  section, not a missing paragraph. Read "perfect" as "nothing sampled was wrong".
- **Noise is lenient.** Navigation hidden behind responsive classes (`d-none`, `hidden`) is
  excluded from must_not_contain because the source does not say whether it is visible, so
  some pages have one boilerplate snippet or none.
- **Structure counts are floors.** They are capped at 1 and counted in the core of the
  content, so extra headings or list items from boilerplate neither help nor hurt. The
  structure score does not check that a table's cells or a code block's indentation survived.
- **Substring matching ignores order and spacing.** An engine that emitted the right words in
  the wrong place, or glued words together, still matches.
- **`onlyMainContent` means different things.** Each engine applies its own rules for the same
  flag; that difference is what the noise and recall columns measure.
- **Corpus selection.** Pages were dropped when the plain GET returned an empty shell, a
  redirect stub or a bot challenge (they belong in the live corpus), so the static corpus
  under-represents JavaScript-dependent sites. 22 candidate URLs were skipped for robots.txt,
  403/404 or timeouts.
- **One machine, shared.** Numbers depend on what else is running. Run engines one at a time.

## Truth review

Reviewed by eye against the source page: 70 truth files in full (every fourth page of the
first draft, then every page the generator flagged as weak and every page touched by a fix),
plus the complete list of 404 must_not_contain snippets across all 216 pages. After a trial
run, every snippet firecrawl-engine missed on 12 pages was checked against the source HTML
to decide whether the truth or the engine was wrong. In all 12 the truth stood (see the last
list), so no truth was changed because of an engine's output.

What the review changed in the generator:

1. A self-closing `<button/>` swallowed a whole page (martinfowler.com): end tags now close
   through buttons as browsers do.
2. A short heading ("flex") blocked every other snippet as a "duplicate": the overlap check
   now ignores short strings.
3. Prose inside layout tables (paulgraham.com, Hacker News) was skipped as table content:
   only data tables are excluded now.
4. Text split by `<br><br>` was one giant block, so early, mid and late all came from the
   top: double breaks now split blocks.
5. "Late" snippets landed on article footers ("This page was last modified on"), feedback
   widgets, comment policies, newsletter promos, author bios, a testimonial carousel and
   tooltips: those classes are now excluded, tooltips count as hidden, and prose is taken from
   the prose core only.
6. A language-switcher line inside an article `<header>` was picked as "early": no prose is
   taken from `<header>`.
7. Wrong headings: a site-name `<h1>` ("The Go Blog"), the site tagline from `<title>`
   (zh.wikipedia), navigation text ("Hacker News"). The `<h1>` matching `<title>` wins, title
   segments must occur in the main text, and two-character CJK headings are accepted.
8. A `<header>` holding the page's only `<h1>` was treated as boilerplate and its text used as
   must_not_contain (motherfuckingwebsite.com): a header containing an `<h1>` is never boilerplate.
9. Breadcrumbs inside `<main>` (Kubernetes) and document tables of contents (RFC 9110, the
   Wikipedia sidebar) were used as must_not_contain: boilerplate now has to be outside `<main>`,
   and a table of contents is never scored.
10. Boilerplate snippets that were too generic ("Table of Contents") or, in CJK, a 60-character
    run: minimum 18 letters, CJK capped.
11. Thread navigation links ("Next by Date: ...") were must_contain on a mail-archive page:
    pages whose text is in `<pre>` now take their snippets from it.
12. Snippets starting after an inline element could have unbalanced brackets or quotes: rejected.
13. Tables: a code block built as a table of lines (test site) and Go by Example's two-column
    docs/code layout were counted as data tables, and one fragment was "Unlimited Unlimited
    Unlimited". Tables holding `<pre>` or code are layout; fragment cells must differ.
14. Structure counts were inflated by related-post grids (107 headings on one Discord post):
    headings and list items are counted inside the prose core.
15. Seven pages were dropped: three JavaScript shells (now in the live corpus), two
    client-redirect stubs, a GitHub repository with no rendered README (its snippets were a
    visually hidden heading and a file-list row), and a product grid with one usable snippet.

Checked and left alone, because the source supports the truth and the engine's output does not:

- Headings inside a `<header>` element in the article (Stripe, Cloudflare, GitHub blogs and
  13 other pages): the `<h1>` is in the source's main content.
- IEEE Spectrum: the article body is in the source HTML inside `div.widget`.
- SQLite changelog: a sentence inside an `<ol>` with no `<li>`; browsers render it.
- Hacker News: the top bar and footer links are boilerplate even in a table layout.
- GitHub READMEs and the Rust book: `<h2><a>…</a></h2>` headings are headings.

Known weak spots left in the truth: three tiny pages have only 2 snippets; pages whose
navigation is hidden with responsive classes have 0 or 1 boilerplate snippets; on one
pricing page all three prose snippets are FAQ questions.

## Results on 2026-11-10

One run of each engine on a Mac Studio (M5 Max), engines one at a time. The self-hosted
server and the Linux engine ran in the same Linux VM (6 CPUs, 12 GB); the first engine row
ran natively on macOS. Numbers move from run to run, so treat small gaps as noise.

Static suite, 216 saved pages served from localhost.

| | Pages/s at c=1, 8, 32 | Errors at c=32 | Idle memory | Peak memory | Recall | Structure | Perfect pages |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Engine, macOS, browser auto | 54, 114, 124 | 0% | 11 MB | 1,862 MB | 0.994 | 0.981 | 89.8% |
| Engine, Linux container, browser off | 56, 243, 237 | 0% | 20 MB | 594 MB | 0.994 | 0.981 | 89.8% |
| Self-hosted server (`bench/selfhost`) | 1.1, 1.1, 0.9 | 18.5% | 2,534 MB | 4,844 MB | 0.966 | 0.775 | 79.6% |

With the browser on, one page in the corpus is a JavaScript shell that takes about 1.7 s to
render, and that one render sets the wall time of a 216-page pass. With the browser off the
engine reads that page's static HTML and moves on.

Live corpus, 119 URLs, one pass at concurrency 4.

| | Content correct (104 scored pages) | JavaScript pages | Hard pages (not scored) |
| --- | --- | --- | --- |
| Engine, macOS | 99 | 25 of 29 | 8 of 15 |
| Self-hosted server | 78 | 7 of 29 | 8 of 15 |

Held-out sample, 300 URLs from Firecrawl's public dataset, concurrency 4.

| | Truth found | Found and clean | Pages/s |
| --- | --- | --- | --- |
| Engine, macOS | 127 | 113 | 2.2 |
| Self-hosted server | 114 | 101 | 1.5 |

Known gaps in the engine at this point: memory taken during a heavy run is not handed back
to the system afterwards, PDFs can lose "fi" ligatures and show symbol-font bullets as
letters, and Windows is untested.

## Held-out check

The static and live corpora were used while building the engine, so they cannot show how it
does on pages nobody looked at. `heldout.mjs` covers that with Firecrawl's public scrape
dataset (Hugging Face `firecrawl/scrape-content-dataset-v1`, MIT, 1,000 live URLs, each with
one text that should be in the output and one that should not).

```sh
# Once: download the CSV into its own folder and draw a seeded sample, one URL per domain
mkdir -p bench/.work/heldout-src && curl -L -o bench/.work/heldout-src/1-0-0.csv \
  https://huggingface.co/datasets/firecrawl/scrape-content-dataset-v1/resolve/main/1-0-0.csv
node bench/heldout-sample.mjs --csv bench/.work/heldout-src/1-0-0.csv --n 300

# Per engine, with the engine already listening
node bench/heldout.mjs --engine firecrawl-engine --base-url http://127.0.0.1:3912
```

It reports pages where the truth text was found, pages that were also clean, and pages per
second at concurrency 4. Live pages change and some have gone since the dataset was built,
so read the numbers as a comparison between engines run on the same day, not as a score.
