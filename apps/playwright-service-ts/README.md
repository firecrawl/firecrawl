# Playwright Scrape API

This is a web scraping service built with Express and Playwright, enhanced with anti-detection capabilities.

## Features

- Scrapes HTML content from specified URLs.
- **Anti-fingerprinting & stealth mode** to bypass anti-bot systems (Cloudflare, etc.)
- Blocks requests to known ad-serving domains.
- Blocks media files to reduce bandwidth usage.
- Uses random user-agent strings to avoid detection.
- Strategy to ensure the page is fully rendered.
- Masks automation indicators (navigator.webdriver, chrome runtime, etc.)

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
