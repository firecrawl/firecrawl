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
    <a href="https://twitter.com/firecrawl">
      <img src="https://img.shields.io/badge/Follow%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X" />
    </a>
    <a href="https://www.linkedin.com/company/104100957">
      <img src="https://img.shields.io/badge/Follow%20on%20LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" alt="Follow on LinkedIn" />
    </a>
    <a href="https://discord.gg/firecrawl">
      <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord" />
    </a>
  </p>
</div>

---

# **🔥 Firecrawl**

**The API to search, scrape, and interact with the web at scale. 🔥** The web context API to find sources, extract content, and turn it into clean Markdown or structured data your agents can ship with. Open source and available as a [hosted service](https://firecrawl.dev/?ref=github).

_Pst. Hey, you, join our stargazers :)_

<a href="https://github.com/firecrawl/firecrawl">
  <img src="https://img.shields.io/github/stars/firecrawl/firecrawl.svg?style=social&label=Star&maxAge=2592000" alt="GitHub stars">
</a>

---

## Why Firecrawl?

- **Industry-leading reliability**: Covers 96% of the web, including JS-heavy pages — no proxy headaches, just clean data ([see benchmarks](https://www.firecrawl.dev/blog/the-worlds-best-web-data-api-v25))
- **Blazingly fast**: P95 latency of 3.4s across millions of pages, built for real-time agents and dynamic apps
- **LLM-ready output**: Clean markdown, structured JSON, screenshots, and more — spend fewer tokens, build better AI apps
- **We handle the hard stuff**: Rotating proxies, orchestration, rate limits, JS-blocked content, and more — zero configuration
- **Agent ready**: Connect Firecrawl to any AI agent or MCP client with a single command
- **Media parsing**: Parse and extract content from web-hosted PDFs, DOCX, and more
- **Actions**: Click, scroll, write, wait, and press before extracting content
- **Open source**: Developed transparently and collaboratively — [join our community](https://github.com/firecrawl/firecrawl)

---

## Feature Overview

**Core Endpoints**

| Feature | Description |
|---------|-------------|
| [**Search**](#search) | Search the web and get full page content from results |
| [**Scrape**](#scrape) | Convert any URL to markdown, HTML, screenshots, or structured JSON |
| [**Interact**](#interact) | Scrape a page, then interact with it using AI prompts or code |

**More**

| Feature | Description |
|---------|-------------|
| [**Agent**](#agent) | Automated data gathering, just describe what you need |
| [**Crawl**](#crawl) | Scrape all URLs of a website with a single request |
| [**Map**](#map) | Discover all URLs on a website instantly |
| [**Batch Scrape**](#batch-scrape) | Scrape thousands of URLs asynchronously |

---

## Quick Start

Sign up at [firecrawl.dev](https://firecrawl.dev) to get your API key. Try the [playground](https://firecrawl.dev/playground) to test it out.

### Search

Search the web and get full content from results.

```python
from firecrawl import Firecrawl

app = Firecrawl(api_key="fc-YOUR_API_KEY")

search_result = app.search("firecrawl", limit=5)
```

<details>
<summary><b>Node.js / cURL / CLI</b></summary>

**Node.js**
```javascript
import { Firecrawl } from 'firecrawl';

const app = new Firecrawl({apiKey: "fc-YOUR_API_KEY"});

app.search("firecrawl", { limit: 5 })
```

**cURL**
```bash
curl -X POST 'https://api.firecrawl.dev/v2/search' \
-H 'Authorization: Bearer fc-YOUR_API_KEY' \
-H 'Content-Type: application/json' \
-d '{
  "query": "firecrawl",
  "limit": 5
}'
```

**CLI**
```bash
firecrawl search "firecrawl" --limit 5
```
</details>

Output:
```json
[
  {
    "url": "https://firecrawl.dev",
    "title": "Firecrawl",
    "markdown": "Turn websites into..."
  },
  {
    "url": "https://docs.firecrawl.dev",
    "title": "Firecrawl Docs",
    "markdown": "# Getting Started..."
  }
]
```

### Scrape

Get LLM-ready data from any website — markdown, JSON, screenshots, and more.

```python
from firecrawl import Firecrawl

app = Firecrawl(api_key="fc-YOUR_API_KEY")

result = app.scrape('firecrawl.dev')
```

<details>
<summary><b>Node.js / cURL / CLI</b></summary>

**Node.js**
```javascript
import { Firecrawl } from 'firecrawl';

const app = new Firecrawl({ apiKey: "fc-YOUR_API_KEY" });

app.scrape('firecrawl.dev')
```

**cURL**
```bash
curl -X POST 'https://api.firecrawl.dev/v2/scrape' \
-H 'Authorization: Bearer fc-YOUR_API_KEY' \
-H 'Content-Type: application/json' \
-d '{
  "url": "firecrawl.dev"
}'
```

**CLI**
```bash
firecrawl scrape https://firecrawl.dev
firecrawl https://firecrawl.dev --only-main-content
```
</details>

Output:
```
# Firecrawl

Firecrawl helps AI systems search, scrape, and interact with the web.

## Features
- Search: Find information across the web
- Scrape: Clean data from any page
- Interact: Click, navigate, and operate pages
- Agent: Autonomous data gathering
```

### Interact

Scrape a page, then interact with it using AI prompts or code.

```python
from firecrawl import Firecrawl

app = Firecrawl(api_key="fc-YOUR_API_KEY")

result = app.scrape("https://amazon.com")
scrape_id = result.metadata.scrape_id

app.interact(scrape_id, prompt="Search for 'mechanical keyboard'")
app.interact(scrape_id, prompt="Click the first result")
```

<details>
<summary><b>Node.js / cURL / CLI</b></summary>

**Node.js**
```javascript
import { Firecrawl } from 'firecrawl';

const app = new Firecrawl({apiKey: "fc-YOUR_API_KEY"});

const result = await app.scrape("https://amazon.com");

await app.interact(result.metadata.scrapeId, {
  prompt: "Search for 'mechanical keyboard'"
});
await app.interact(result.metadata.scrapeId, {
  prompt: "Click the first result"
});
```

**cURL**
```bash
# 1. Scrape the page
curl -X POST 'https://api.firecrawl.dev/v2/scrape' \
-H 'Authorization: Bearer fc-YOUR_API_KEY' \
-H 'Content-Type: application/json' \
-d '{"url": "https://amazon.com"}'

# 2. Interact with the page (use scrapeId from step 1)
curl -X POST 'https://api.firecrawl.dev/v2/scrape/SCRAPE_ID/interact' \
-H 'Authorization: Bearer fc-YOUR_API_KEY' \
-H 'Content-Type: application/json' \
-d '{"prompt": "Search for mechanical keyboard"}'
```

**CLI**
```bash
firecrawl scrape https://amazon.com
firecrawl interact exec --prompt "Search for 'mechanical keyboard'"
firecrawl interact exec --prompt "Click the first result"
```
</details>

Output:
```json
{
  "success": true,
  "output": "Keyboard available at $100",
  "liveViewUrl": "https://liveview.firecrawl.dev/..."
}
```

---

## Power Your Agent

Connect Firecrawl to any AI agent or MCP client in minutes.

### Skill

Give your agent easy access to real-time web data with one command.

```bash
npx -y firecrawl-cli@latest init --all --browser
```

Restart your agent after installing. Works with [Claude Code](https://claude.ai/code), [Antigravity](https://antigravity.google), [OpenCode](https://opencode.ai), and more.

### MCP

Connect any MCP-compatible client to the web in seconds.

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "fc-YOUR_API_KEY"
      }
    }
  }
}
```

### Agent Onboarding

Are you an AI agent? Fetch this skill to sign up your user, get an API key, and start building with Firecrawl.

```bash
curl -s https://firecrawl.dev/agent-onboarding/SKILL.md
```

See the [Skill + CLI documentation](https://docs.firecrawl.dev/sdks/cli) for all available commands. For MCP, see [firecrawl-mcp-server](https://github.com/firecrawl/firecrawl-mcp-server).

---

## More Endpoints

### Agent

**The easiest way to get data from the web.** Describe what you need, and our AI agent searches, navigates, and retrieves it. No URLs required.

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

#### Agent with Structured Output

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

#### Agent with URLs (Optional)

Focus the agent on specific pages:
```python
result = app.agent(
    urls=["https://docs.firecrawl.dev", "https://firecrawl.dev/pricing"],
    prompt="Compare the features and pricing information"
)
```

#### Model Selection

Choose between two models based on your needs:

| Model | Cost | Best For |
|-------|------|----------|
| `spark-1-mini` (default) | 60% cheaper | Most tasks |
| `spark-1-pro` | Standard | Complex research, critical data gathering |
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

### Crawl

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

#### Check Crawl Status
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

### Map

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

#### Map with Search

Find specific URLs within a site:
```python
from firecrawl import Firecrawl

app = Firecrawl(api_key="fc-YOUR_API_KEY")

result = app.map("https://firecrawl.dev", search="pricing")
# Returns URLs ordered by relevance to "pricing"
```

### Batch Scrape

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

Our SDKs provide a convenient way to use all Firecrawl features and automatically handle polling for async operations.

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
results = app.search("best AI data tools 2024", limit=10)
print(results)
```

### Node.js

Install the SDK:
```bash
npm install firecrawl
```
```javascript
import { Firecrawl } from 'firecrawl';

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
const results = await app.search('best AI data tools 2024', { limit: 10 });
results.data.web.forEach(result => {
    console.log(`${result.title}: ${result.url}`);
});
```

### Java

Add the dependency ([Gradle/Maven](https://docs.firecrawl.dev/sdks/java#installation)):
```groovy
repositories {
    mavenCentral()
    maven { url 'https://jitpack.io' }
}

dependencies {
    implementation 'com.github.firecrawl:firecrawl-java-sdk:2.0'
}
```
```java
import dev.firecrawl.client.FirecrawlClient;
import dev.firecrawl.model.*;

FirecrawlClient client = new FirecrawlClient(
    System.getenv("FIRECRAWL_API_KEY"), null, null
);

// Scrape a single URL
ScrapeParams scrapeParams = new ScrapeParams();
scrapeParams.setFormats(new String[]{"markdown"});
FirecrawlDocument doc = client.scrapeURL("https://firecrawl.dev", scrapeParams);
System.out.println(doc.getMarkdown());

// Use the Agent for autonomous data gathering
AgentParams agentParams = new AgentParams("Find the founders of Stripe");
AgentResponse start = client.createAgent(agentParams);
AgentStatusResponse result = client.getAgentStatus(start.getId());
System.out.println(result.getData());

// Crawl a website (polls until completion)
CrawlParams crawlParams = new CrawlParams();
crawlParams.setLimit(50);
CrawlStatusResponse job = client.crawlURL("https://docs.firecrawl.dev", crawlParams, null, 10);
for (FirecrawlDocument page : job.getData()) {
    System.out.println(page.getMetadata().get("sourceURL"));
}

// Search the web
SearchParams searchParams = new SearchParams("best AI data tools 2024");
searchParams.setLimit(10);
SearchResponse results = client.search(searchParams);
for (SearchResult r : results.getResults()) {
    System.out.println(r.getTitle() + ": " + r.getUrl());
}
```

### Elixir

Add the dependency:
```elixir
def deps do
  [
    {:firecrawl, "~> 1.0"}
  ]
end
```
```elixir
# Scrape a URL
{:ok, response} = Firecrawl.scrape_and_extract_from_url(
  url: "https://firecrawl.dev",
  formats: ["markdown"]
)

# Crawl a website
{:ok, response} = Firecrawl.crawl_urls(
  url: "https://docs.firecrawl.dev",
  limit: 50
)

# Search the web
{:ok, response} = Firecrawl.search_and_scrape(
  query: "best AI data tools 2024",
  limit: 10
)

# Map URLs
{:ok, response} = Firecrawl.map_urls(url: "https://example.com")
```

### Rust

Add the dependency:
```toml
[dependencies]
firecrawl = "2"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```
```rust
use firecrawl::{Client, ScrapeOptions, Format, CrawlOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new("fc-YOUR_API_KEY")?;

    // Scrape a URL
    let document = client.scrape("https://firecrawl.dev", None).await?;
    println!("{:?}", document.markdown);

    // Crawl a website
    let options = CrawlOptions {
        limit: Some(50),
        ..Default::default()
    };
    let result = client.crawl("https://docs.firecrawl.dev", options).await?;
    println!("Crawled {} pages", result.data.len());

    // Search the web
    let response = client.search("best web scraping tools 2024", None).await?;
    println!("{:?}", response.data);

    Ok(())
}
```

### Community SDKs

- [Go SDK](https://github.com/firecrawl/firecrawl/tree/main/apps/go-sdk)

---

## Integrations

**Agents & AI Tools**
- [Firecrawl Skill](https://docs.firecrawl.dev/sdks/cli)
- [Firecrawl CLI Skills](https://github.com/firecrawl/cli#agent-skills)
- [Firecrawl Workflows](https://github.com/firecrawl/firecrawl-workflows)
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

![Open Source vs Cloud](https://raw.githubusercontent.com/firecrawl/firecrawl/main/img/open-source-cloud.png)

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
