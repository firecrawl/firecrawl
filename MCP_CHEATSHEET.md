# Firecrawl MCP Cheat Sheet

## Setup

```bash
# One-liner (Claude Code, Cursor, Windsurf, etc.)
env FIRECRAWL_API_KEY=fc-YOUR_KEY npx -y firecrawl-mcp

# Self-hosted
env FIRECRAWL_API_URL=https://firecrawl.your-domain.com npx -y firecrawl-mcp
```

**`claude_desktop_config.json` / Cursor / Windsurf:**
```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": { "FIRECRAWL_API_KEY": "fc-YOUR_KEY" }
    }
  }
}
```

---

## Tool Selection Guide

| I want to… | Use |
|---|---|
| Get content from **one URL** | `firecrawl_scrape` |
| Get content from **multiple known URLs** | `firecrawl_batch_scrape` |
| **Discover URLs** on a site | `firecrawl_map` |
| **Search the web** for information | `firecrawl_search` |
| Scrape **all pages** of a site section | `firecrawl_crawl` |
| Extract **structured data** with LLM | `firecrawl_extract` |
| **Complex research** across unknown sources | `firecrawl_agent` |
| **Click, type, navigate** interactively | `firecrawl_browser_*` |

**Format rule:** Prefer `json` format with a schema to avoid context overflow. Use `markdown` only when you need the full page text.

---

## Tools

### `firecrawl_scrape` — Single page

```json
{
  "url": "https://example.com/product",
  "formats": [{
    "type": "json",
    "prompt": "Extract product info",
    "schema": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "price": { "type": "number" }
      },
      "required": ["name", "price"]
    }
  }]
}
```

Other formats: `"markdown"`, `"html"`, `"screenshot"`, `"branding"` (colors, fonts, logo)

Key options: `onlyMainContent: true`, `actions` (click/wait/scroll before scrape)

---

### `firecrawl_batch_scrape` — Multiple URLs

```json
{
  "urls": ["https://example.com/p1", "https://example.com/p2"],
  "options": { "formats": ["markdown"], "onlyMainContent": true }
}
```

Returns a `batch_id` → poll with `firecrawl_check_batch_status`

---

### `firecrawl_check_batch_status`

```json
{ "id": "batch_1" }
```

---

### `firecrawl_map` — URL discovery

```json
{ "url": "https://example.com" }
```

Returns `URL[]`. Use before `batch_scrape` when you don't know the exact URLs.

Options: `search: "pricing"` (filter by keyword), `limit`, `includeSubdomains`

---

### `firecrawl_search` — Web search

```json
{
  "query": "latest AI research 2025",
  "limit": 5,
  "lang": "en",
  "country": "us",
  "scrapeOptions": { "formats": ["markdown"], "onlyMainContent": true }
}
```

---

### `firecrawl_crawl` — Full site crawl (async)

```json
{
  "url": "https://example.com/blog/*",
  "maxDepth": 2,
  "limit": 50,
  "allowExternalLinks": false,
  "deduplicateSimilarURLs": true
}
```

Returns a `job_id` → poll with `firecrawl_check_crawl_status`

> **Warning:** Keep `limit` low — large crawls overflow context. Prefer `map` + `batch_scrape`.

---

### `firecrawl_check_crawl_status`

```json
{ "id": "550e8400-..." }
```

---

### `firecrawl_extract` — LLM-powered extraction

```json
{
  "urls": ["https://example.com/page1", "https://example.com/page2"],
  "prompt": "Extract product name, price, and description",
  "schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string" },
      "price": { "type": "number" },
      "description": { "type": "string" }
    }
  }
}
```

Options: `enableWebSearch: true`, `allowExternalLinks`, `includeSubdomains`

---

### `firecrawl_agent` — Autonomous researcher (async)

```json
{
  "prompt": "Find the top 5 AI startups founded in 2024 with funding amounts",
  "schema": {
    "type": "object",
    "properties": {
      "startups": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "funding": { "type": "string" }
          }
        }
      }
    }
  }
}
```

Optional `urls` to focus the agent. Returns a `job_id` → poll with `firecrawl_agent_status` every 10–30s.

---

### `firecrawl_agent_status`

```json
{ "id": "550e8400-..." }
```

Statuses: `processing` → keep polling | `completed` → data available | `failed`

---

### Browser tools — Interactive automation

```json
// 1. Create session
{ "ttl": 600, "profile": { "name": "my-profile", "saveChanges": true } }
// → returns sessionId

// 2. Execute (bash recommended)
{
  "sessionId": "...",
  "code": "agent-browser open https://example.com",
  "language": "bash"
}

// 3. Delete when done
{ "sessionId": "..." }
```

**Common `agent-browser` commands:**

| Command | Action |
|---|---|
| `agent-browser open <url>` | Navigate to URL |
| `agent-browser snapshot` | Get accessibility tree + element refs |
| `agent-browser click @e5` | Click element by ref |
| `agent-browser type @e3 "text"` | Type into element |
| `agent-browser screenshot` | Take screenshot |
| `agent-browser get title` | Get page title |

For Playwright: use `"language": "python"` with `await page.goto(...)` syntax.

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `FIRECRAWL_API_KEY` | — | Cloud API key (required for cloud) |
| `FIRECRAWL_API_URL` | cloud | Self-hosted instance URL |
| `FIRECRAWL_RETRY_MAX_ATTEMPTS` | `3` | Max retries on rate limit |
| `FIRECRAWL_RETRY_INITIAL_DELAY` | `1000` | First retry delay (ms) |
| `FIRECRAWL_RETRY_MAX_DELAY` | `10000` | Max retry delay (ms) |
| `FIRECRAWL_RETRY_BACKOFF_FACTOR` | `2` | Exponential backoff multiplier |
| `FIRECRAWL_CREDIT_WARNING_THRESHOLD` | `1000` | Warn at N credits remaining |
| `FIRECRAWL_CREDIT_CRITICAL_THRESHOLD` | `100` | Critical alert at N credits |

---

## Common Patterns

```
# Research a topic  →  search → scrape top results (JSON)
# Scrape a product catalog  →  map → batch_scrape (JSON schema)
# Monitor a site  →  crawl (low limit) or schedule via /v1/schedules API
# Interact with a login wall  →  browser_create → browser_execute → scrape
# Extract structured data at scale  →  extract (with schema)
```
