<h3 align="center">
  <a name="readme-top"></a>
  <img
    src="https://raw.githubusercontent.com/firecrawl/firecrawl/main/img/firecrawl_logo.png"
    height="200"
  >
</h3>

<div align="center">
  <a href="https://github.com/firecrawl/firecrawl/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/firecrawl/firecrawl" alt="License">
  </a>
  <a href="https://pepy.tech/project/firecrawl-py">
    <img src="https://static.pepy.tech/badge/firecrawl-py" alt="Downloads">
  </a>
  <a href="https://GitHub.com/firecrawl/firecrawl/graphs/contributors">
    <img src="https://img.shields.io/github/contributors/firecrawl/firecrawl.svg" alt="GitHub Contributors">
  </a>
  <a href="https://firecrawl.dev">
    <img src="https://img.shields.io/badge/Visit-firecrawl.dev-orange" alt="Visit firecrawl.dev">
  </a>
</div>

<div>
  <p align="center">
    <a href="https://twitter.com/firecrawl_dev">
      <img src="https://img.shields.io/badge/Follow%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X" />
    </a>
    <a href="https://www.linkedin.com/company/104100957">
      <img src="https://img.shields.io/badge/Follow%20on%20LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" alt="Follow on LinkedIn" />
    </a>
    <a href="https://discord.com/invite/gSmWdAkdwd">
      <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord" />
    </a>
  </p>
</div>

---

# **🔥 Firecrawl**

**Turn websites into LLM-ready data.** 

[**Firecrawl**](https://firecrawl.dev/?ref=github) is an API that scrapes, crawls, and extracts structured data from any website, powering AI agents and apps with real-time context from the web.

Looking for our MCP? Check out the repo [here](https://github.com/firecrawl/firecrawl-mcp-server).

*This repository is in development, and we're still integrating custom modules into the mono repo. It's not fully ready for self-hosted deployment yet, but you can run it locally.*

_Pst. Hey, you, join our stargazers :)_

<a href="https://github.com/firecrawl/firecrawl">
  <img src="https://img.shields.io/github/stars/firecrawl/firecrawl.svg?style=social&label=Star&maxAge=2592000" alt="GitHub stars">
</a>

---

## Why Firecrawl?

- **LLM-ready output**: Clean markdown, structured JSON, screenshots, HTML, and more
- **Industry-leading reliability**: >80% coverage on [benchmark evaluations](https://www.firecrawl.dev/blog/the-worlds-best-web-data-api-v25), outperforming every other provider tested
- **Handles the hard stuff**: Proxies, JavaScript rendering, and dynamic content that breaks other scrapers
- **Customization**: Exclude tags, crawl behind auth walls, max depth, and more
- **Media parsing**: Automatic text extraction from PDFs, DOCX, and images
- **Actions**: Click, scroll, input, wait, and more before extracting
- **Batch processing**: Scrape thousands of URLs asynchronously
- **Change tracking**: Monitor website content changes over time

---

## Quick Start

Sign up at [firecrawl.dev](https://firecrawl.dev) to get your API key and start extracting data in seconds. Try the [playground](https://firecrawl.dev/playground) to test it out.

### Make Your First API Request
```bash
curl -X POST 'https://api.firecrawl.dev/v2/scrape' \
  -H 'Authorization: Bearer fc-YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com"}'
```

Response:
```json
{
  "success": true,
  "data": {
    "markdown": "# Example Domain\n\nThis domain is for use in illustrative examples...",
    "metadata": {
      "title": "Example Domain",
      "sourceURL": "https://example.com"
    }
  }
}
```

---

## Feature Overview

| Feature | Description |
|---------|-------------|
| [**Scrape**](#scraping) | Convert any URL to markdown, HTML, screenshots, or structured JSON |
| [**Search**](#search) | Search the web and get full page content from results |
| [**Agent**](#agent) | Automated data gathering, just describe what you need |
| [**Crawl**](#crawling) | Scrape all URLs of a website with a single request |
| [**Map**](#map) | Discover all URLs on a website instantly |

---

## Scrape

Convert any URL to clean markdown, HTML, or structured data.
```bash
curl -X POST 'https://api.firecrawl.dev/v2/scrape' \
  -H 'Authorization: Bearer fc-YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://docs.firecrawl.dev",
    "formats": ["markdown", "html"]
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "markdown": "# Firecrawl Docs\n\nTurn websites into LLM-ready data...",
    "html": "<!DOCTYPE html><html>...",
    "metadata": {
      "title": "Quickstart | Firecrawl",
      "description": "Firecrawl allows you to turn entire websites into LLM-ready markdown",
      "sourceURL": "https://docs.firecrawl.dev",
      "statusCode": 200
    }
  }
}
```

### Extract Structured Data (JSON Mode)

Extract structured data using a schema:
```python
from firecrawl import Firecrawl
from pydantic import BaseModel

app = Firecrawl(api_key="fc-YOUR_API_KEY")

class CompanyInfo(BaseModel):
    company_mission: str
    is_open_source: bool
    is_in_yc: bool

result = app.scrape(
    'https://firecrawl.dev',
    formats=[{"type": "json", "schema": CompanyInfo.model_json_schema()}]
)

print(result.json)
```
```json
{"company_mission": "Turn websites into LLM-ready data", "is_open_source": true, "is_in_yc": true}
```

Or extract with just a prompt (no schema):
```python
result = app.scrape(
    'https://firecrawl.dev',
    formats=[{"type": "json", "prompt": "Extract the company mission"}]
)
```

### Scrape Formats

Available formats: `markdown`, `html`, `rawHtml`, `screenshot`, `links`, `json`, `branding`

**Get a screenshot**
```python
doc = app.scrape("https://firecrawl.dev", formats=["screenshot"])
print(doc.screenshot)  # Base64 encoded image
```

**Extract brand identity (colors, fonts, typography)**
```python
doc = app.scrape("https://firecrawl.dev", formats=["branding"])
print(doc.branding)  # {"colors": {...}, "fonts": [...], "typography": {...}}
```

### Actions (Interact Before Scraping)

Click, type, scroll, and more before extracting:
```python
doc = app.scrape(
    url="https://example.com/login",
    formats=["markdown"],
    actions=[
        {"type": "write", "text": "user@example.com"},
        {"type": "press", "key": "Tab"},
        {"type": "write", "text": "password"},
        {"type": "click", "selector": 'button[type="submit"]'},
        {"type": "wait", "milliseconds": 2000},
        {"type": "screenshot"}
    ]
)
```

---

## Search

Search the web and optionally scrape the results.
```bash
curl -X POST 'https://api.firecrawl.dev/v2/search' \
  -H 'Authorization: Bearer fc-YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "firecrawl web scraping",
    "limit": 5
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "web": [
      {
        "url": "https://www.firecrawl.dev/",
        "title": "Firecrawl - The Web Data API for AI",
        "description": "The web crawling, scraping, and search API for AI.",
        "position": 1
      }
    ],
    "images": [...],
    "news": [...]
  }
}
```

### Search with Content Scraping

Get the full content of search results:
```python
from firecrawl import Firecrawl

firecrawl = Firecrawl(api_key="fc-YOUR_API_KEY")

results = firecrawl.search(
    "firecrawl web scraping",
    limit=3,
    scrape_options={
        "formats": ["markdown", "links"]
    }
)
```

---

## Agent

**The easiest way to get data from the web.** Describe what you need, and our AI agent searches, navigates, and extracts it. No URLs required.

Agent is the evolution of our `/extract` endpoint: faster, more reliable, and doesn't require you to know the URLs upfront.
```bash
curl -X POST 'https://api.firecrawl.dev/v2/agent' \
  -H 'Authorization: Bearer fc-YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "Find the pricing plans for Notion"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "result": "Notion offers the following pricing plans:\n\n1. Free - $0/month...\n2. Plus - $10/seat/month...\n3. Business - $18/seat/month...",
    "sources": ["https://www.notion.so/pricing"]
  }
}
```

### Agent with Structured Output

Use a schema to get structured data:
```python
from firecrawl import Firecrawl
from pydantic import BaseModel, Field
from typing import List, Optional

app = Firecrawl(api_key="fc-YOUR_API_KEY")

class Founder(BaseModel):
    name: str = Field(description="Full name of the founder")
    role: Optional[str] = Field(None, description="Role or position")

class FoundersSchema(BaseModel):
    founders: List[Founder] = Field(description="List of founders")

result = app.agent(
    prompt="Find the founders of Firecrawl",
    schema=FoundersSchema
)

print(result.data)
```
```json
{
  "founders": [
    {"name": "Eric Ciarla", "role": "Co-founder"},
    {"name": "Nicolas Camara", "role": "Co-founder"},
    {"name": "Caleb Peffer", "role": "Co-founder"}
  ]
}
```

### Agent with URLs (Optional)

Focus the agent on specific pages:
```python
result = app.agent(
    urls=["https://docs.firecrawl.dev", "https://firecrawl.dev/pricing"],
    prompt="Compare the features and pricing information"
)
```

### Model Selection

Choose between two models based on your needs:

| Model | Cost | Best For |
|-------|------|----------|
| `spark-1-mini` (default) | 60% cheaper | Most tasks |
| `spark-1-pro` | Standard | Complex research, critical extraction |
```python
result = app.agent(
    prompt="Compare enterprise features across Firecrawl, Apify, and ScrapingBee",
    model="spark-1-pro"
)
```

**When to use Pro:**
- Comparing data across multiple websites
- Extracting from sites with complex navigation or auth
- Research tasks where the agent needs to explore multiple paths
- Critical data where accuracy is paramount

Learn more about Spark models in our [Agent documentation](https://docs.firecrawl.dev/features/agent).

### Using Firecrawl with AI agents

Install the Firecrawl skill to let AI agents like Claude Code, Codex, and OpenCode use Firecrawl automatically:
```bash
npx skills add firecrawl/cli
```

Restart your agent after installing. See the [Skill + CLI docs](https://docs.firecrawl.dev/sdks/cli) for full setup.

---

## Crawling

Crawl an entire website and get content from all pages.
```bash
curl -X POST 'https://api.firecrawl.dev/v2/crawl' \
  -H 'Authorization: Bearer fc-YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://docs.firecrawl.dev",
    "limit": 100,
    "scrapeOptions": {
      "formats": ["markdown"]
    }
  }'
```

Returns a job ID:
```json
{
  "success": true,
  "id": "123-456-789",
  "url": "https://api.firecrawl.dev/v2/crawl/123-456-789"
}
```

### Check Crawl Status
```bash
curl -X GET 'https://api.firecrawl.dev/v2/crawl/123-456-789' \
  -H 'Authorization: Bearer fc-YOUR_API_KEY'
```
```json
{
  "status": "completed",
  "total": 50,
  "completed": 50,
  "creditsUsed": 50,
  "data": [
    {
      "markdown": "# Page Title\n\nContent...",
      "metadata": {"title": "Page Title", "sourceURL": "https://..."}
    }
  ]
}
```

**Note:** The [SDKs](#sdks) handle polling automatically for a better developer experience.

---

## Map

Discover all URLs on a website instantly.
```bash
curl -X POST 'https://api.firecrawl.dev/v2/map' \
  -H 'Authorization: Bearer fc-YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://firecrawl.dev"}'
```

Response:
```json
{
  "success": true,
  "links": [
    {"url": "https://firecrawl.dev", "title": "Firecrawl", "description": "Turn websites into LLM-ready data"},
    {"url": "https://firecrawl.dev/pricing", "title": "Pricing", "description": "Firecrawl pricing plans"},
    {"url": "https://firecrawl.dev/blog", "title": "Blog", "description": "Firecrawl blog"}
  ]
}
```

### Map with Search

Find specific URLs within a site:
```python
from firecrawl import Firecrawl

app = Firecrawl(api_key="fc-YOUR_API_KEY")

result = app.map("https://firecrawl.dev", search="pricing")
# Returns URLs ordered by relevance to "pricing"
```

---

## Batch Scraping

Scrape multiple URLs at once:
```python
from firecrawl import Firecrawl

app = Firecrawl(api_key="fc-YOUR_API_KEY")

job = app.batch_scrape([
    "https://firecrawl.dev",
    "https://docs.firecrawl.dev",
    "https://firecrawl.dev/pricing"
], formats=["markdown"])

for doc in job.data:
    print(doc.metadata.source_url)
```

---

## SDKs

Our SDKs provide a convenient way to interact with all Firecrawl features and automatically handle polling for async operations like crawling and batch scraping.

### Python

Install the SDK:
```bash
pip install firecrawl-py
```
```python
from firecrawl import Firecrawl

app = Firecrawl(api_key="fc-YOUR_API_KEY")

# Scrape a single URL
doc = app.scrape("https://firecrawl.dev", formats=["markdown"])
print(doc.markdown)

# Use the Agent for autonomous data gathering
result = app.agent(prompt="Find the founders of Stripe")
print(result.data)

# Crawl a website (automatically waits for completion)
docs = app.crawl("https://docs.firecrawl.dev", limit=50)
for doc in docs.data:
    print(doc.metadata.source_url, doc.markdown[:100])

# Search the web
results = app.search("best web scraping tools 2024", limit=10)
print(results)
```

### Node.js

Install the SDK:
```bash
npm install @mendable/firecrawl-js
```
```javascript
import Firecrawl from '@mendable/firecrawl-js';

const app = new Firecrawl({ apiKey: 'fc-YOUR_API_KEY' });

// Scrape a single URL
const doc = await app.scrape('https://firecrawl.dev', { formats: ['markdown'] });
console.log(doc.markdown);

// Use the Agent for autonomous data gathering
const result = await app.agent({ prompt: 'Find the founders of Stripe' });
console.log(result.data);

// Crawl a website (automatically waits for completion)
const docs = await app.crawl('https://docs.firecrawl.dev', { limit: 50 });
docs.data.forEach(doc => {
    console.log(doc.metadata.sourceURL, doc.markdown.substring(0, 100));
});

// Search the web
const results = await app.search('best web scraping tools 2024', { limit: 10 });
results.data.web.forEach(result => {
    console.log(`${result.title}: ${result.url}`);
});
```

### Community SDKs

- [Go SDK](https://github.com/mendableai/firecrawl-go)
- [Rust SDK](https://docs.firecrawl.dev/sdks/rust)

---

## Integrations

**Agents & AI Tools**
- [Firecrawl Skill](https://docs.firecrawl.dev/sdks/cli)
- [Firecrawl MCP](https://github.com/mendableai/firecrawl-mcp-server)

**Platforms**
- [Lovable](https://docs.lovable.dev/integrations/firecrawl)
- [Zapier](https://zapier.com/apps/firecrawl/integrations)
- [n8n](https://n8n.io/integrations/firecrawl/)

[View all integrations →](https://www.firecrawl.dev/integrations)

**Missing your favorite tool?** [Open an issue](https://github.com/mendableai/firecrawl/issues) and let us know!

---

## Resources

- [Documentation](https://docs.firecrawl.dev)
- [API Reference](https://docs.firecrawl.dev/api-reference/introduction)
- [Playground](https://firecrawl.dev/playground)
- [Changelog](https://firecrawl.dev/changelog)

---

## Open Source vs Cloud

Firecrawl is open source under the AGPL-3.0 license. The cloud version at [firecrawl.dev](https://firecrawl.dev) includes additional features:

![Open Source vs Cloud](https://raw.githubusercontent.com/firecrawl/firecrawl/main/img/open-source-cloud-comparison.png)

To run locally, see the [Contributing Guide](https://github.com/firecrawl/firecrawl/blob/main/CONTRIBUTING.md). To self-host, see [Self-Hosting Guide](https://docs.firecrawl.dev/contributing/self-host).

---

## Contributing

We love contributions! Please read our [Contributing Guide](https://github.com/firecrawl/firecrawl/blob/main/CONTRIBUTING.md) before submitting a pull request.

### Contributors

<a href="https://github.com/firecrawl/firecrawl/graphs/contributors">
  <img alt="contributors" src="https://contrib.rocks/image?repo=firecrawl/firecrawl"/>
</a>

---

## License

This project is primarily licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). The SDKs and some UI components are licensed under the MIT License. See the LICENSE files in specific directories for details.

---

**It is the sole responsibility of end users to respect websites' policies when scraping.** Users are advised to adhere to applicable privacy policies and terms of use. By default, Firecrawl respects robots.txt directives. By using Firecrawl, you agree to comply with these conditions.

<p align="right" style="font-size: 14px; color: #555; margin-top: 20px;">
  <a href="#readme-top" style="text-decoration: none; color: #007bff; font-weight: bold;">
    ↑ Back to Top ↑
  </a>
</p>
