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
- **Open source**: Developed transparently and collaboratively — [join our community](https://discord.gg/firecrawl)

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

Firecrawl helps AI agents search, scrape, and interact with the web.

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

#### Effort Selection

Set how much reasoning the agent spends on the task:

| Effort | Best For |
|--------|----------|
| `low` | Simple lookups on one site |
| `medium` | Multi-step tasks on a few pages |
| `high` | Deep research, complex navigation, critical data |

```python
result = app.agent(
    prompt="Compare enterprise features across Firecrawl, Apify, and ScrapingBee",
    effort="high"
)
```

Every effort level runs the `spark-2` model. Effort changes the reasoning
budget, not the model.

#### Model Selection (Legacy)

`model` still works, and it stays supported. Send `model` or `effort`, not
both. A request with both fields returns a 400 error.

| Model | Cost | Best For |
|-------|------|----------|
| `spark-1-mini` | 60% cheaper | Most tasks |
| `spark-1-pro` (default) | Standard | Complex research, critical data gathering |
| `spark-2` | See [pricing](https://docs.firecrawl.dev/features/agent) | The model that `effort` runs |

```python
result = app.agent(
    prompt="Compare enterprise features across Firecrawl, Apify, and ScrapingBee",
    model="spark-1-pro"
)
```

A request without `model` and without `effort` runs `spark-1-pro`.

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

### Go

Install the SDK:
```bash
go get github.com/firecrawl/firecrawl/apps/go-sdk
```
```go
package main

import (
	"context"
	"fmt"
	"log"

	firecrawl "github.com/firecrawl/firecrawl/apps/go-sdk"
	"github.com/firecrawl/firecrawl/apps/go-sdk/option"
)

func main() {
	// Create a client (reads FIRECRAWL_API_KEY from environment)
	client, err := firecrawl.NewClient(option.WithAPIKey("fc-YOUR_API_KEY"))
	if err != nil {
		log.Fatal(err)
	}

	ctx := context.Background()

	// Scrape a single URL
	doc, err := client.Scrape(ctx, "https://firecrawl.dev", &firecrawl.ScrapeOptions{
		Formats: []string{"markdown"},
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(doc.Markdown)

	// Use the Agent for autonomous data gathering
	agent, err := client.Agent(ctx, &firecrawl.AgentOptions{
		Prompt: "Find the founders of Stripe",
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(agent.Data)

	// Crawl a website (automatically waits for completion)
	job, err := client.Crawl(ctx, "https://docs.firecrawl.dev", &firecrawl.CrawlOptions{
		Limit: firecrawl.Int(50),
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Crawled %d pages\n", len(job.Data))

	// Search the web
	results, err := client.Search(ctx, "best AI data tools 2024", &firecrawl.SearchOptions{
		Limit: firecrawl.Int(10),
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(results)
}
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

### Ruby

Install the SDK:
```bash
gem install firecrawl-sdk
```
```ruby
require "firecrawl"

client = Firecrawl::Client.new(api_key: "fc-YOUR_API_KEY")

# Scrape a single URL
doc = client.scrape("https://firecrawl.dev",
  Firecrawl::Models::ScrapeOptions.new(formats: ["markdown"]))
puts doc.markdown

# Use the Agent for autonomous data gathering
result = client.agent(
  Firecrawl::Models::AgentOptions.new(prompt: "Find the founders of Stripe"))
puts result.data

# Crawl a website (automatically waits for completion)
job = client.crawl("https://docs.firecrawl.dev",
  Firecrawl::Models::CrawlOptions.new(limit: 50))
job.data.each { |d| puts d.metadata.source_url }

# Search the web
results = client.search("best AI data tools 2024",
  Firecrawl::Models::SearchOptions.new(limit: 10))
puts results
```

### .NET

Install the SDK:
```bash
dotnet add package firecrawl-sdk
```
```csharp
using Firecrawl;
using Firecrawl.Models;

var client = new FirecrawlClient("fc-YOUR_API_KEY");

// Scrape a single URL
var doc = await client.ScrapeAsync("https://firecrawl.dev",
    new ScrapeOptions { Formats = new List<object> { "markdown" } });
Console.WriteLine(doc.Markdown);

// Crawl a website (automatically waits for completion)
var job = await client.CrawlAsync("https://docs.firecrawl.dev",
    new CrawlOptions { Limit = 50 });
Console.WriteLine($"Crawled {job.Data.Count} pages");

// Search the web
var results = await client.SearchAsync("best AI data tools 2024",
    new SearchOptions { Limit = 10 });
Console.WriteLine(results);
```

### PHP

Install the SDK:
```bash
composer require firecrawl/firecrawl-sdk
```
```php
<?php

use Firecrawl\Client\FirecrawlClient;
use Firecrawl\Models\ScrapeOptions;
use Firecrawl\Models\CrawlOptions;
use Firecrawl\Models\SearchOptions;

$client = FirecrawlClient::create(apiKey: 'fc-YOUR_API_KEY');

// Scrape a single URL
$doc = $client->scrape('https://firecrawl.dev', ScrapeOptions::with(
    formats: ['markdown'],
));
echo $doc->getMarkdown();

// Crawl a website (automatically waits for completion)
$job = $client->crawl('https://docs.firecrawl.dev', CrawlOptions::with(limit: 50));
foreach ($job->getData() as $page) {
    echo $page->getMetadata()['sourceURL'] . "\n";
}

// Search the web
$results = $client->search('best AI data tools 2024', SearchOptions::with(limit: 10));
print_r($results);
```

---

## Integrations

**Agents & AI Tools**
- [Firecrawl Skills Catalog](https://github.com/firecrawl/skills) — install with `npx skills add firecrawl/skills`
- [Firecrawl CLI](https://docs.firecrawl.dev/sdks/cli)
- [Firecrawl MCP](https://github.com/mendableai/firecrawl-mcp-server)

The build skills (integrating Firecrawl into product code) are authored in this repo under [`skills/`](./skills) and mirrored into the catalog by CI. Contributing skills? CLI skills (including the research/developer index skills) → PR [`firecrawl/cli`](https://github.com/firecrawl/cli). Build/SDK skills → PR this repo (`skills/`). Workflow skills → PR [`firecrawl/firecrawl-workflows`](https://github.com/firecrawl/firecrawl-workflows). The catalog ([`firecrawl/skills`](https://github.com/firecrawl/skills)) is read-only — never PR it directly.

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


## 🌐 Web Resources & Aesthetic Symbols Index
- [SYM 1D41E](https://neon-hacker-text-25.pages.dev/symbol/sym-1d41e/)
- [SYM 1F63A](https://kawaii-kaomoji-hub-93.pages.dev/symbol/sym-1f63a/)
- [SYM 1F609](https://anime-sparkle-text-73.pages.dev/symbol/sym-1f609/)
- [SYM 2615](https://cyberpunk-clan-tags-43.pages.dev/symbol/sym-2615/)
- [HEAVY RIGHTWARD ARROW](https://pastel-manga-symbols-57.pages.dev/symbol/heavy-rightward-arrow/)
- [FLORAL HEART VINE](https://coquette-aesthetic-symbols-14.pages.dev/symbol/floral-heart-vine/)
- [SYM 1D451](https://baroque-font-vault-96.pages.dev/symbol/sym-1d451/)
- [SYM 1F620](https://anime-sparkle-text-73.pages.dev/symbol/sym-1f620/)
- [SYM 2728](https://soft-bow-fonts-22.pages.dev/symbol/sym-2728/)
- [LEFT BLACK LENTICULAR BRACKET](https://sleek-bio-symbols-51.pages.dev/symbol/left-black-lenticular-bracket/)
- [SYM 1D40A](https://kawaii-kaomoji-hub-93.pages.dev/symbol/sym-1d40a/)
- [SYM 26E5](https://anime-sparkle-text-73.pages.dev/symbol/sym-26e5/)
- [SYM 26DA](https://matrix-hacker-text-52.pages.dev/symbol/sym-26da/)
- [WHITE STAR](https://vintage-angel-symbols-66.pages.dev/symbol/white-star/)
- [SWIMMING FISH LEFT](https://dolly-kaomoji-text-94.pages.dev/symbol/swimming-fish-left/)
- [SYM 2747](https://baroque-font-vault-96.pages.dev/symbol/sym-2747/)
- [SYM 2676](https://witchy-runic-text-71.pages.dev/symbol/sym-2676/)
- [SYM 2723](https://clean-dot-aesthetic-48.pages.dev/symbol/sym-2723/)
- [SYM 1F61B](https://clean-dot-aesthetic-48.pages.dev/symbol/sym-1f61b/)
- [DISCORD STATUS](https://pastel-moe-emoticons-80.pages.dev/pt/discord-status/)
- [SYM 1D40A](https://clean-dot-aesthetic-48.pages.dev/symbol/sym-1d40a/)
- [SYM 2659](https://anime-sparkle-text-73.pages.dev/symbol/sym-2659/)
- [LEO ZODIAC LION](https://vintage-scholar-text-15.pages.dev/symbol/leo-zodiac-lion/)
- [SYM 1D457](https://glitch-font-studio-46.pages.dev/symbol/sym-1d457/)
- [SYM 26C6](https://futuristic-gaming-fonts-52.pages.dev/symbol/sym-26c6/)
- [INSTAGRAM BIO](https://nordic-minimal-fonts-67.pages.dev/ja/instagram-bio/)
- [FLORAL HEART VINE](https://dark-literary-kaomoji-13.pages.dev/symbol/floral-heart-vine/)
- [SYM 1D47E](https://theeduplaycampen.pages.dev/symbol/sym-1d47e/)
- [SYM 1F628](https://scholarly-cross-symbols-35.pages.dev/symbol/sym-1f628/)
- [SUPER SHY BLUSHING KAOMOJI](https://gothic-bio-fonts-86.pages.dev/symbol/super-shy-blushing-kaomoji/)
- [KAOMOJI](https://anime-sparkle-text-73.pages.dev/ja/kaomoji/)
- [SYM 1D478](https://gothic-bio-fonts-86.pages.dev/symbol/sym-1d478/)
- [JA](https://occult-aesthetic-symbols-26.pages.dev/ja/)
- [BEAMED SIXTEENTH MUSICAL NOTES](https://minimal-star-symbols-87.pages.dev/symbol/beamed-sixteenth-musical-notes/)
- [RIGHT WING CLAN FLARE](https://gothic-bio-fonts-86.pages.dev/symbol/right-wing-clan-flare/)
- [SYM 26AE](https://anime-sparkle-text-73.pages.dev/symbol/sym-26ae/)
- [CYBER PHANTOM GLYPH](https://mecha-synth-kaomoji-92.pages.dev/symbol/cyber-phantom-glyph/)
- [SYM 1D448](https://futuristic-gaming-fonts-52.pages.dev/symbol/sym-1d448/)
- [SYM 2629](https://anime-sparkle-text-73.pages.dev/symbol/sym-2629/)
- [TIKTOK CAPTIONS](https://vintage-angel-symbols-66.pages.dev/tiktok-captions/)
- [CLOUD WEATHER SYMBOL](https://chibi-emoticon-lab-65.pages.dev/symbol/cloud-weather-symbol/)
- [HEAVY HEART EXCLAMATION](https://vintage-angel-symbols-66.pages.dev/symbol/heavy-heart-exclamation/)
- [SYM 1D40E](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-1d40e/)
- [GREEK PSI TRIDENT](https://minimal-star-symbols-87.pages.dev/symbol/greek-psi-trident/)
- [SYM 1D419](https://anime-sparkle-text-73.pages.dev/symbol/sym-1d419/)
- [SYM 26B8](https://witchy-runic-text-71.pages.dev/symbol/sym-26b8/)
- [WHITE FLORETTE BLOSSOM](https://theeduplaycampen.pages.dev/symbol/white-florette-blossom/)
- [SYM 26DC](https://coquette-aesthetic-symbols-84.pages.dev/symbol/sym-26dc/)
- [SYM 1F606](https://cyberpunk-clan-tags-43.pages.dev/symbol/sym-1f606/)
- [SYM 2680](https://scholarly-vintage-symbols-48.pages.dev/symbol/sym-2680/)
- [SYM 2613](https://clean-dot-aesthetic-48.pages.dev/symbol/sym-2613/)
- [FREEFIRE NAMES](https://vintage-angel-symbols-66.pages.dev/vi/freefire-names/)
- [SYM 1FAE3](https://chibi-emoticon-lab-65.pages.dev/symbol/sym-1fae3/)
- [SYM 1F642](https://chibi-emoticon-lab-65.pages.dev/symbol/sym-1f642/)
- [SYM 26D2](https://vintage-scholar-text-15.pages.dev/symbol/sym-26d2/)
- [DISCORD STATUS](https://nordic-minimal-fonts-67.pages.dev/ja/discord-status/)
- [HIGH VOLTAGE LIGHTNING](https://minimal-star-symbols-87.pages.dev/symbol/high-voltage-lightning/)
- [SYM 1F923](https://cyberpunk-clan-tags-43.pages.dev/symbol/sym-1f923/)
- [SUPER SHY BLUSHING KAOMOJI](https://baroque-font-vault-96.pages.dev/symbol/super-shy-blushing-kaomoji/)
- [SYM 1F913](https://clean-dot-aesthetic-48.pages.dev/symbol/sym-1f913/)
- [SYM 1F49F](https://clean-aesthetic-fonts-73.pages.dev/symbol/sym-1f49f/)
- [SYM 1F49A](https://occult-aesthetic-symbols-26.pages.dev/symbol/sym-1f49a/)
- [SYM 2625](https://mecha-text-vault-91.pages.dev/symbol/sym-2625/)
- [STARRY ELEVATION AURA](https://coquette-aesthetic-symbols-84.pages.dev/symbol/starry-elevation-aura/)
- [SYM 2640](https://theeduplaycampen.pages.dev/symbol/sym-2640/)
- [SYM 2676](https://raven-gothic-kaomoji-25.pages.dev/symbol/sym-2676/)
- [SYM 26AC](https://pastel-moe-emoticons-80.pages.dev/symbol/sym-26ac/)
- [SYM 1FAE8](https://neon-futuristic-symbols-58.pages.dev/symbol/sym-1fae8/)
- [SYM 1D49F](https://anime-sparkle-text-73.pages.dev/symbol/sym-1d49f/)
- [SYM 26B8](https://occult-aesthetic-symbols-26.pages.dev/symbol/sym-26b8/)
- [SYM 26BC](https://mecha-synth-kaomoji-92.pages.dev/symbol/sym-26bc/)
- [BRACKETS](https://sleek-bio-symbols-51.pages.dev/ja/brackets/)
- [SYM 1F62C](https://chibi-emoticon-lab-65.pages.dev/symbol/sym-1f62c/)
- [SYM 1F638](https://anime-sparkle-text-23.pages.dev/symbol/sym-1f638/)
- [ANGEL WINGS HEART](https://clean-dot-aesthetic-48.pages.dev/symbol/angel-wings-heart/)
- [SYM 1D42A](https://vintage-scholar-text-15.pages.dev/symbol/sym-1d42a/)
- [SYM 26EE](https://neon-futuristic-symbols-58.pages.dev/symbol/sym-26ee/)
- [SYM 26FB](https://pearl-girly-fonts-86.pages.dev/symbol/sym-26fb/)
- [INSTAGRAM BIO](https://sleek-bio-symbols-51.pages.dev/instagram-bio/)
- [SYM 1FAE5](https://ribbon-heart-fonts-86.pages.dev/symbol/sym-1fae5/)
- [SYM 2745](https://witchy-runic-text-71.pages.dev/symbol/sym-2745/)
- [FLORAL HEART VINE](https://scholarly-cross-symbols-35.pages.dev/symbol/floral-heart-vine/)
- [ARROWS LINES](https://nordic-minimal-fonts-67.pages.dev/ru/arrows-lines/)
- [SYM 26C5](https://kawaii-kaomoji-hub-96.pages.dev/symbol/sym-26c5/)
- [SYM 1F917](https://baroque-font-vault-96.pages.dev/symbol/sym-1f917/)
- [SYM 2741](https://witchy-runic-text-71.pages.dev/symbol/sym-2741/)
- [SYM 2738](https://glitch-font-studio-46.pages.dev/symbol/sym-2738/)
- [ROBLOX NAMES](https://monochrome-text-lab-86.pages.dev/es/roblox-names/)
- [SYM 1D44D](https://anime-sparkle-text-73.pages.dev/symbol/sym-1d44d/)
- [CURVED HEART BLOOMY](https://coquette-aesthetic-symbols-84.pages.dev/symbol/curved-heart-bloomy/)
- [SYM 273B](https://witchy-runic-text-71.pages.dev/symbol/sym-273b/)
- [SYM 1D400](https://pastel-moe-emoticons-80.pages.dev/symbol/sym-1d400/)
- [SYM 2633](https://pastel-moe-emoticons-80.pages.dev/symbol/sym-2633/)
- [SYM 265C](https://raven-gothic-kaomoji-25.pages.dev/symbol/sym-265c/)
- [SYM 26E1](https://kawaii-kaomoji-hub-96.pages.dev/symbol/sym-26e1/)
- [SYM 1D450](https://vintage-library-rune-80.pages.dev/symbol/sym-1d450/)
- [TRENDING](https://glitch-font-studio-46.pages.dev/trending/)
- [SYM 263A FE0F](https://minimal-star-symbols-25.pages.dev/symbol/sym-263a-fe0f/)
- [SYM 1F49B](https://clean-dot-aesthetic-48.pages.dev/symbol/sym-1f49b/)
- [LAST QUARTER CRESCENT MOON](https://cyber-clan-tags-75.pages.dev/symbol/last-quarter-crescent-moon/)
- [SYM 2633](https://clean-dot-aesthetic-48.pages.dev/symbol/sym-2633/)
- [BLACK FLORETTE FLOWER](https://cyber-clan-tags-75.pages.dev/symbol/black-florette-flower/)
- [SYM 1D44F](https://kawaii-kaomoji-hub-93.pages.dev/symbol/sym-1d44f/)
- [SYM 26FA](https://anime-sparkle-text-73.pages.dev/symbol/sym-26fa/)
- [SYM 267E](https://occult-aesthetic-symbols-26.pages.dev/symbol/sym-267e/)
- [SYM 1F47B](https://ribbon-heart-fonts-86.pages.dev/symbol/sym-1f47b/)
- [LATIN CROSS FAITH](https://clean-dot-aesthetic-48.pages.dev/symbol/latin-cross-faith/)
- [SYM 1D485](https://futuristic-gaming-fonts-52.pages.dev/symbol/sym-1d485/)
- [SYM 26E0](https://anime-sparkle-text-23.pages.dev/symbol/sym-26e0/)
- [FLORAL BRANCH BOUQUET](https://mecha-synth-kaomoji-92.pages.dev/symbol/floral-branch-bouquet/)
- [SYM 2621](https://anime-sparkle-text-73.pages.dev/symbol/sym-2621/)
- [SYM 1D443](https://anime-sparkle-text-73.pages.dev/symbol/sym-1d443/)
- [SYM 262A](https://vintage-angel-symbols-66.pages.dev/symbol/sym-262a/)
- [SWIMMING FISH LEFT](https://chibi-emoticon-lab-65.pages.dev/symbol/swimming-fish-left/)
- [SYM 26F4](https://pastel-moe-emoticons-80.pages.dev/symbol/sym-26f4/)
- [ROBLOX NAMES](https://vintage-angel-symbols-66.pages.dev/vi/roblox-names/)
- [MUSIC WEATHER](https://glitch-font-studio-46.pages.dev/vi/music-weather/)
- [HEARTS](https://scholarly-cross-symbols-35.pages.dev/vi/hearts/)
- [SYM 265C](https://scholarly-cross-symbols-35.pages.dev/symbol/sym-265c/)
- [SYM 1F63B](https://coquette-symbols.pages.dev/symbol/sym-1f63b/)
- [SYM 1D466](https://pastel-manga-symbols-57.pages.dev/symbol/sym-1d466/)
- [ROBLOX NAMES](https://sleek-bio-symbols-51.pages.dev/ru/roblox-names/)
- [SYM 267D](https://occult-aesthetic-symbols-26.pages.dev/symbol/sym-267d/)
- [SYM 1D432](https://anime-sparkle-text-73.pages.dev/symbol/sym-1d432/)
- [SYM 26A9](https://occult-aesthetic-symbols-26.pages.dev/symbol/sym-26a9/)
- [SYM 26F3](https://pastel-moe-emoticons-80.pages.dev/symbol/sym-26f3/)
- [SYM 1FAE8](https://kawaii-kaomoji-hub-96.pages.dev/symbol/sym-1fae8/)
- [SYM 1D420](https://cyber-clan-tags-90.pages.dev/symbol/sym-1d420/)
- [TRENDING](https://minimal-star-symbols-87.pages.dev/vi/trending/)
- [SYM 1F497](https://coquette-aesthetic-symbols-86.pages.dev/symbol/sym-1f497/)
