# Playwright Scrape API

This is a simple web scraping service built with Express and Playwright.

## Features

- Scrapes HTML content from specified URLs.
- Blocks requests to known ad-serving domains.
- Blocks media files to reduce bandwidth usage.
- Uses random user-agent strings to avoid detection.
- Strategy to ensure the page is fully rendered.

## Install
```bash
npm install
npx playwright install
```

## RUN
```bash
npm run build
npm start
```
OR
```bash
npm run dev
```

## CONFIGURATION

All settings are environment variables. None are required.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3003` | Port the service listens on. |
| `PROXY_SERVER` | none | Upstream proxy for all page traffic. |
| `PROXY_USERNAME` | none | Username, if the proxy authenticates. |
| `PROXY_PASSWORD` | none | Password, if the proxy authenticates. |
| `BLOCK_MEDIA` | `false` | Drop images, audio and video to save bandwidth. |
| `ALLOW_LOCAL_WEBHOOKS` | `false` | Permit scraping local and private-network addresses. Leave off unless the deployment is airgapped or you have another control in front of it. |
| `MAX_CONCURRENT_PAGES` | `10` | Pages open at once across all contexts. |
| `STEALTH_MODE` | `off` | How hard to work at not looking automated — see below. |

### STEALTH_MODE

Sites that fingerprint headless browsers can serve a scraper something other
than the page — in one observed case a Shopify theme navigated the browser to
google.com instead. This controls how much of that fingerprint the service
hides. It is off by default because it changes how the scraper represents
itself to the sites it visits, which is the operator's call.

| Value | Effect | Measured fingerprint |
| --- | --- | --- |
| `off` (default) | Nothing added. | `webdriver=true`, `plugins=0`, `hasChrome=false` |
| `basic` | Launches Chromium with `--disable-blink-features=AutomationControlled`. | `webdriver=false`, `plugins=0`, `hasChrome=false` |
| `full` | `basic`, plus init-script shims for `window.chrome` and `navigator.plugins`. | `webdriver=false`, `plugins=2`, `hasChrome=true` |

Prefer `basic`: it clears the tell detectors check first, and unlike `full` it
runs no init script on the pages you load. The `full` shims only define a
property that is absent, so a future Playwright or Chromium that populates
them natively takes precedence.

Note that the service already randomises the user-agent per context regardless
of this setting.

## USE

```bash
curl -X POST http://localhost:3000/scrape \
-H "Content-Type: application/json" \
-d '{
  "url": "https://example.com",
  "wait_after_load": 1000,
  "timeout": 15000,
  "headers": {
    "Custom-Header": "value"
  },
  "check_selector": "#content"
}'
```

## USING WITH FIRECRAWL

Add `PLAYWRIGHT_MICROSERVICE_URL=http://localhost:3003/scrape` to `/apps/api/.env` to configure the API to use this Playwright microservice for scraping operations.
