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

## CONFIGURATION

| Variable | Default | Description |
| --- | --- | --- |
| `VIEWPORT_WIDTH` | `1280` | Browser viewport width in pixels. |
| `VIEWPORT_HEIGHT` | `800` | Browser viewport height in pixels. Pages that virtualize long lists only render rows that fit in the viewport, so a larger value (for example `4000`) captures more rows without scroll actions. |

Invalid or empty values fall back to the defaults. In the root `docker-compose.yaml` these are set through
`PLAYWRIGHT_VIEWPORT_WIDTH` and `PLAYWRIGHT_VIEWPORT_HEIGHT`.

## USING WITH FIRECRAWL

Add `PLAYWRIGHT_MICROSERVICE_URL=http://localhost:3003/scrape` to `/apps/api/.env` to configure the API to use this Playwright microservice for scraping operations.
