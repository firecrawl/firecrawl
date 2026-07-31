# Search profiles

Firecrawl now classifies each search into one deterministic profile in
`apps/api/src/search/profiles.ts`. Explicit API categories always win; otherwise
query intent selects `general`, `developer`, `research`, or `pdf`. Each profile
runs a small set of SearXNG engine groups in parallel, then Firecrawl
canonicalizes, filters, deduplicates, and ranks their combined results.

For a new deployment, copy `settings.example.yml` to the ignored
`settings.yml`, replace its placeholder secret, and put the GitHub and Brave
tokens in `.env`. Compose passes those credentials to SearXNG without writing
them into either settings file.

SearXNG `!bang` prefixes remain useful for direct SearXNG clients, but Firecrawl
callers should prefer the API categories because those also enforce result
domains and PDF-like URLs.

## Profiles

Prefix the query. Multiple bangs union their engines.

| API category | Structured engines | Web coverage |
|---|---|---|
| `github` | GitHub, plus ecosystem engines only when named by the query | Authenticated Brave site search for GitHub, GitLab, and Stack Overflow |
| `research` | Crossref, OpenAlex, and PubMed for biomedical intent | Authenticated Brave search restricted to scholarly domains |
| `pdf` | Crossref and OpenAlex | Separate Brave and Bing `filetype:pdf` groups |
| omitted/general | Stable general-web engines | Brave is isolated from the other engines so quota pressure cannot discard their results |

Bang shortcuts: `!pub` pubmed, `!cr` crossref, `!oa` openalex, `!oap`
openairepublications, `!arx` arxiv, `!gos` google scholar, `!se` semantic
scholar, `!gh` github, `!st` stackoverflow, `!hf` huggingface, `!mdn` mdn,
`!bi` bing, `!wp` wikipedia. Full list at `http://127.0.0.1:8999/config`.

Category bangs also work: `!science`, `!it`, `!general`.

## Safesearch

`safe_search: 0` is global in `settings.yml` and Firecrawl never sends a
`safesearch` param, so nothing filters sexual-health or abuse-pattern queries.
Measured on the same query: 64 results at level 0, 65 at 1, 56 at 2 — the
engines in this set barely filter regardless, but 0 is what runs.

Academic queries in this domain return exactly what they should — Frontiers,
PMC, APA, CDC, Wiley, Taylor & Francis, ScienceDirect — with no bangs needed.

## Engine health (measured 2026-07-31, from this IP)

Working in the routed profiles: authenticated GitHub, PubMed, Crossref,
OpenAlex, authenticated Brave API, Bing, Dogpile, Seznam, Yandex, Fynd, and
conditional ecosystem indexes such as npm and PyPI.

The academic engines are profile-only. A live ordinary Firecrawl search on
2026-07-30 showed Google Scholar CAPTCHA and OpenAlex 429 errors because the
client's explicit `SEARXNG_ENGINES` list forced them to run despite their
non-general categories. They were removed from that default list; bangs still
override the list when academic coverage is wanted.

Broken, and why:

- `semantic scholar` — JSONDecodeError on every call
  (`semantic_scholar.py:108`); the unauthenticated endpoint returns non-JSON.
  **Removed from the default set.** A free key re-enables it:
  https://www.semanticscholar.org/product/api#api-key-form
- `arxiv` — `export.arxiv.org` repeatedly consumed the full 10–15 second
  engine timeout during the final live audit. It was removed from synchronous
  structured groups. arXiv remains covered through Brave's `site:arxiv.org`
  search, and PDF results are normalized to `arxiv.org/pdf/<id>`.
- `reddit` — `access denied`, permanently suspended. Do not add; it is the
  obvious pick for qualitative/lived-experience data and it does not work.
- `google` — loads if you set `inactive: false`, but soft-blocks from this IP:
  zero results, no error, nothing logged. Burns a request slot.
- `google cse` — `too many requests`, because it is still on upstream's
  hardcoded shared CX. Needs your own CX (not an API key), see `settings.yml`.
- `duckduckgo`, `brave` (keyless HTML), `startpage`, `qwant`, `gmx`, and
  `privacywall` — CAPTCHA, 429, or parser failures even through the configured
  residential exits. Disabled after live validation on 2026-07-30; keeping
  them enabled made every query look unhealthy without improving coverage.
- `github` — the upstream engine timed out because it inherited HTTP/2. The
  local `github_authenticated` wrapper uses the `gh` token from
  `SEARXNG_GITHUB_TOKEN` and forces HTTP/1.1 for this engine only.

## Brave budget and burst behavior

The configured key has a low per-second ceiling. The local
`braveapi_authenticated` wrapper spaces dispatches by 2.1 seconds, bounds its
queue to 4.5 seconds, and shortens SearXNG's 429 suspension to two seconds.
Brave is always a separate Firecrawl engine group, so a skipped or rate-limited
Brave call cannot suppress results from GitHub, Crossref, OpenAlex, Bing, or
the remaining general engines.

Check remaining budget:

```sh
curl -sI 'https://api.search.brave.com/res/v1/web/search?q=test' \
  -H "X-Subscription-Token: $BRAVE_KEY" | grep -i x-ratelimit
```
