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

## Configuration

Environment variables:

- `PORT`: HTTP port to listen on (defaults to `3003`).
- `PROXY_SERVER`: Proxy server URL (e.g. `http://proxy:8080`).
- `PROXY_USERNAME`: Optional proxy username.
- `PROXY_PASSWORD`: Optional proxy password.
- `WARN_NO_PROXY`: Set to `false` to silence the "No proxy server provided" warning when running without an explicit proxy (defaults to `true`).
- `SILENCE_PROXY_WARNING`: Set to `true` or `1` as an alternative switch to silence the proxy warning.
- `BLOCK_MEDIA`: Set to `true` to block media requests.
- `MAX_CONCURRENT_PAGES`: Maximum concurrent browser pages (defaults to `10`).
- `ALLOW_LOCAL_WEBHOOKS`: Allow connections to internal/local addresses.

## USING WITH FIRECRAWL

Add `PLAYWRIGHT_MICROSERVICE_URL=http://localhost:3003/scrape` to `/apps/api/.env` to configure the API to use this Playwright microservice for scraping operations.
