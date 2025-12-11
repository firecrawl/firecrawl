# Engine Forcing

This feature allows you to force specific scraping engines for certain domains based on URL patterns. This is useful when you know that certain websites work better with specific engines.

## Configuration

The engine forcing is configured via the `FORCED_ENGINE_DOMAINS` environment variable. This should be a JSON object mapping domain patterns to engines.

### Environment Variable Format

```json
{
  "example.com": "playwright",
  "test.com": "fetch",
  "*.subdomain.com": "fire-engine;chrome-cdp",
  "google.com": ["fire-engine;chrome-cdp", "playwright"]
}
```

### Supported Patterns

1. **Exact domain match**: `"example.com"` matches `example.com` and all its subdomains (`www.example.com`, `api.example.com`, etc.)
2. **Wildcard pattern**: `"*.subdomain.com"` matches only subdomains of `subdomain.com` (e.g., `api.subdomain.com`, `www.subdomain.com`) but NOT the base domain itself
3. **Single engine**: `"playwright"` forces a single engine
4. **Multiple engines**: `["fire-engine;chrome-cdp", "playwright"]` provides a fallback list of engines to try in order

### Available Engines

- `fire-engine;chrome-cdp` - Advanced browser with Chrome DevTools Protocol
- `fire-engine;playwright` - Playwright-based browser automation
- `fire-engine;tlsclient` - TLS fingerprinting for anti-bot bypass
- `fire-engine;chrome-cdp;stealth` - Chrome CDP with stealth mode
- `fire-engine;playwright;stealth` - Playwright with stealth mode
- `fire-engine;tlsclient;stealth` - TLS client with stealth mode
- `playwright` - Direct Playwright integration
- `fetch` - Simple HTTP requests
- `pdf` - PDF document parsing
- `document` - Office document handling

## How It Works

1. When a scrape request is made, the system checks if the URL matches any domain pattern in `FORCED_ENGINE_DOMAINS`
2. If a match is found, the specified engine(s) are used instead of the default engine selection logic
3. If no match is found, the normal engine selection waterfall is used
4. The engine forcing only applies if `forceEngine` is not already set in the internal options

## Example Configuration

### Example 1: Force Playwright for specific domains

```bash
export FORCED_ENGINE_DOMAINS='{"linkedin.com":"playwright","twitter.com":"playwright"}'
```

This forces Playwright for LinkedIn and Twitter URLs.

### Example 2: Use fetch for simple sites

```bash
export FORCED_ENGINE_DOMAINS='{"example.com":"fetch","httpbin.org":"fetch"}'
```

This uses the simple fetch engine for example.com and httpbin.org.

### Example 3: Complex configuration with wildcards

```bash
export FORCED_ENGINE_DOMAINS='{
  "google.com": ["fire-engine;chrome-cdp", "playwright"],
  "*.cloudflare.com": "fire-engine;tlsclient;stealth",
  "wikipedia.org": "fetch"
}'
```

This configuration:

- Uses fire-engine with Chrome CDP for Google, falling back to Playwright if needed
- Uses fire-engine with TLS client in stealth mode for Cloudflare subdomains
- Uses simple fetch for Wikipedia

## Implementation Details

The engine forcing logic is implemented in:

- `apps/api/src/scraper/WebScraper/utils/engine-forcing.ts` - Core logic
- `apps/api/src/scraper/scrapeURL/index.ts` - Integration into scraping pipeline

The system is initialized at startup in:

- `apps/api/src/index.ts` - Main API server
- `apps/api/src/services/queue-worker.ts` - Queue worker
- `apps/api/src/services/extract-worker.ts` - Extract worker
- `apps/api/src/services/worker/nuq-worker.ts` - NuQ worker

## Precedence

The engine forcing has the following precedence:

1. If `forceEngine` is already set in `InternalOptions`, it takes precedence (engine forcing is skipped)
2. If a URL matches an engine forcing pattern, that engine is used
3. Otherwise, the normal engine selection waterfall is used

## Testing

Unit tests are available in `apps/api/src/scraper/WebScraper/utils/__tests__/engine-forcing.test.ts`.

## Notes

- Domain matching is case-insensitive
- The system handles invalid URLs gracefully by returning `undefined`
- If the JSON in `FORCED_ENGINE_DOMAINS` is invalid, the system logs an error and continues with empty mappings
- The feature is similar to the blocked domains logic but for engine selection instead of blocking
