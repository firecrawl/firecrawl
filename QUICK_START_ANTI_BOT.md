# Quick Start: Anti-Bot Fix

## TL;DR

Firecrawl's Playwright engine now has anti-fingerprinting to bypass Cloudflare and other anti-bot systems.

## Installation (Choose One)

### Option 1: Docker (Recommended)
```bash
# Rebuild and restart
docker-compose build playwright-service
docker-compose up -d

# Verify
docker-compose logs -f playwright-service
```

### Option 2: Local Development
```bash
cd apps/playwright-service-ts
pnpm install
npx playwright install chromium
npm run dev
```

## Quick Test

```bash
# Test the fix works
curl -X POST 'http://localhost:3002/v2/scrape' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer YOUR_API_KEY' \
-d '{
  "url": "https://bot.sannysoft.com/",
  "pageOptions": {
    "engine": "playwright"
  }
}'
```

**Success**: Response contains actual page content, NOT bot detection messages.

## Test Your Original URL

```bash
curl -X POST 'http://localhost:3002/v2/scrape' \
-H 'Content-Type: application/json' \
-H 'Authorization: Bearer YOUR_API_KEY' \
-d '{
  "url": "https://www.example.com/",
  "pageOptions": {
    "engine": "playwright"
  }
}'
```

**Success**: Returns actual content instead of 403 error page.

## What Changed?

✅ Added `playwright-extra` with stealth plugin
✅ Masked `navigator.webdriver` and automation signals  
✅ Randomized browser fingerprints
✅ Added realistic browser properties

## Still Getting Blocked?

### Try 1: Use Stealth Proxy
```json
{
  "url": "https://example.com",
  "proxy": "stealth"
}
```

### Try 2: Add Wait Time
```json
{
  "url": "https://example.com",
  "pageOptions": {
    "engine": "playwright",
    "waitFor": 3000
  }
}
```

### Try 3: Custom Headers
```json
{
  "url": "https://example.com",
  "headers": {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  }
}
```

### Try 4: Configure Proxy (Optional but Recommended)
```bash
# In .env or docker-compose.yaml
PROXY_SERVER=http://your-proxy:8080
PROXY_USERNAME=your_username
PROXY_PASSWORD=your_password
```

## Verification

Run the test script:
```bash
cd apps/playwright-service-ts
node test-anti-detection.js
```

Expected output:
```
✅ Playwright service is healthy
📊 Results: 3 passed, 0 failed
🎉 All tests passed! Anti-detection is working correctly.
```

## Full Documentation

- **Detailed Guide**: `ANTI_BOT_SOLUTION.md`
- **Implementation Details**: `IMPLEMENTATION_SUMMARY.md`
- **Service README**: `apps/playwright-service-ts/README.md`

## Need Help?

1. Check service is running: `curl http://localhost:3003/health`
2. View logs: `docker-compose logs playwright-service`
3. Run test script: `node apps/playwright-service-ts/test-anti-detection.js`
4. Review error messages in the response

## Key Files Modified

```
apps/playwright-service-ts/
├── package.json          # Added stealth dependencies
├── api.ts               # Integrated anti-detection
└── test-anti-detection.js   # New test script
```

---

**Bottom Line**: Your Firecrawl instance should now bypass anti-bot systems just like Browserless.io does, since both now use similar anti-fingerprinting techniques.
