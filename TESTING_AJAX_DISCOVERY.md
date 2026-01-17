# Testing AJAX URL Discovery

This document explains how to test the AJAX URL discovery feature locally.

## Overview

The AJAX discovery feature allows the playwright engine to discover URLs that are loaded dynamically via JavaScript/AJAX, such as:
- Single Page Applications (SPAs)
- Tabs that load content via fetch/XHR
- Infinite scroll pages
- Dynamic filtering/search results

## Test Files

We've created two types of tests:

### 1. Unit Tests (`apps/api/src/scraper/scrapeURL/transformers/__tests__/ajax-discovery.test.ts`)

These tests verify the link merging and deduplication logic without requiring any external services.

**Run unit tests:**
```bash
cd apps/api
pnpm test src/scraper/scrapeURL/transformers/__tests__/ajax-discovery.test.ts
```

**What they test:**
- Merging discovered URLs with HTML-extracted links
- Deduplication when URLs overlap
- Handling empty/undefined discovered URLs
- Edge cases in the merge logic

### 2. End-to-End Tests (`apps/api/src/__tests__/snips/v2/scrape-ajax-discovery.test.ts`)

These tests verify the complete feature integration from API endpoint to response.

**Run E2E tests (requires test harness):**
```bash
cd apps/api
pnpm harness jest src/__tests__/snips/v2/scrape-ajax-discovery.test.ts
```

**What they test:**
- API accepts `discoverAjax` parameter
- Discovered URLs are returned in response
- Default behavior (discoverAjax: false)
- Deduplication in actual responses
- Integration with Camoufox service

**Test URL:** `https://www.scrapethissite.com/pages/ajax-javascript/`
- This page has year tabs (2010-2015) that load Oscar film data via AJAX
- Without discovery: finds 0 crawlable links
- With discovery: finds 6 URLs like `?ajax=true&year=2015`

## Prerequisites

### For Unit Tests
- Node.js and pnpm installed
- Dependencies installed: `pnpm install`

### For E2E Tests
- Full test environment set up
- Playwright/Camoufox microservice running
- Test harness configured

**Note:** E2E tests require the `HAS_PLAYWRIGHT` flag to be true. They will be skipped if the playwright microservice is not available.

## Manual Testing

You can test the feature manually using curl once the API server is running:

### 1. Start the test harness
```bash
cd apps/api
pnpm harness
```

### 2. Test scrape endpoint with AJAX discovery

**With AJAX discovery enabled:**
```bash
curl -X POST http://localhost:3002/v2/scrape \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer fc-test" \
  -d '{
    "url": "https://www.scrapethissite.com/pages/ajax-javascript/",
    "formats": ["links"],
    "discoverAjax": true
  }'
```

**Without AJAX discovery (default):**
```bash
curl -X POST http://localhost:3002/v2/scrape \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer fc-test" \
  -d '{
    "url": "https://www.scrapethissite.com/pages/ajax-javascript/",
    "formats": ["links"]
  }'
```

### 3. Compare results

With `discoverAjax: true`, you should see additional URLs in the `links` array that were discovered by interacting with the page's JavaScript.

## Expected Behavior

1. **Default behavior (discoverAjax: false or not specified):**
   - Only HTML `<a href>` links are extracted
   - No AJAX discovery performed
   - Faster scraping time

2. **With discoverAjax: true:**
   - HTML `<a href>` links are extracted
   - Camoufox clicks interactive elements
   - XHR/fetch requests are captured
   - Discovered URLs are merged with HTML links
   - Duplicates are automatically removed
   - Slower scraping time due to interaction

## Crawl Testing

To test AJAX discovery in a crawl:

```bash
curl -X POST http://localhost:3002/v2/crawl \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer fc-test" \
  -d '{
    "url": "https://www.scrapethissite.com/pages/ajax-javascript/",
    "limit": 10,
    "maxDepth": 2,
    "scrapeOptions": {
      "discoverAjax": true
    }
  }'
```

The crawler should discover and follow the AJAX-loaded URLs.

## Troubleshooting

### Tests are skipped
- Check that `HAS_PLAYWRIGHT` environment variable is set
- Ensure playwright microservice URL is configured
- Verify the test harness is running

### No discovered URLs returned
- Verify Camoufox service is running and accessible
- Check that `discover_ajax` parameter is being passed to the service
- Review service logs for errors
- Confirm the test URL actually has AJAX-loaded content

### TypeScript compilation errors
- Run `pnpm install` to ensure dependencies are up to date
- Check that `@mendable/firecrawl-rs` native module is built

## CI/CD Testing

The tests will run automatically in CI when you open a pull request. The CI environment has all necessary services configured.

## Implementation Details

The feature works as follows:

1. **API Layer:** `discoverAjax` parameter is validated and passed through
2. **Engine Layer:** Playwright engine sends `discover_ajax: true` to Camoufox service
3. **Service Layer:** Camoufox discovers AJAX URLs and returns them
4. **Transformer Layer:** Discovered URLs are merged with HTML-extracted links and deduplicated
5. **Response:** Combined, deduplicated links are returned in the `links` array

See the implementation in:
- `apps/api/src/controllers/v2/types.ts` (API schema)
- `apps/api/src/scraper/scrapeURL/engines/playwright/index.ts` (Engine integration)
- `apps/api/src/scraper/scrapeURL/transformers/index.ts` (Link merging)
