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

## USING WITH FIRECRAWL

Add `PLAYWRIGHT_MICROSERVICE_URL=http://localhost:3003/scrape` to `/apps/api/.env` to configure the API to use this Playwright microservice for scraping operations.

Private scrape targets are blocked by default, including when local DNS cannot resolve a
hostname that an upstream `PROXY_SERVER` could resolve. On trusted self-hosted deployments,
set `ALLOW_PRIVATE_IP_SCRAPING=true` on **both** the API and Playwright service to permit
them. Docker Compose forwards this variable to both services. This bypasses scrape-target
SSRF protection, so keep it disabled if untrusted users can submit scrape URLs. The older
`ALLOW_LOCAL_WEBHOOKS=true` setting also permits private scrape targets for backward
compatibility, but the new flag does not permit local webhook destinations.
