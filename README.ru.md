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

<div align="center">
  <p>
    <a href="README.md">English</a> |
    <a href="README.ru.md">Русский</a>
  </p>
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

**API для поиска, скрапинга и взаимодействия с вебом в масштабе. 🔥** Web context API: находить источники, извлекать контент и превращать его в чистый Markdown или структурированные данные, с которыми могут работать ваши агенты. Open source и доступен как [hosted-сервис](https://firecrawl.dev/?ref=github).

_Pst. Hey, you, join our stargazers :)_

<a href="https://github.com/firecrawl/firecrawl">
  <img src="https://img.shields.io/github/stars/firecrawl/firecrawl.svg?style=social&label=Star&maxAge=2592000" alt="GitHub stars">
</a>

---

## Зачем Firecrawl?

- **Надёжность уровня индустрии**: покрывает 96% веба, включая JS-heavy страницы — без головной боли с прокси, только чистые данные ([benchmarks](https://www.firecrawl.dev/blog/the-worlds-best-web-data-api-v25))
- **Очень быстро**: P95 latency 3.4s на миллионах страниц — для real-time агентов и динамических приложений
- **LLM-ready output**: чистый markdown, structured JSON, скриншоты и другое — меньше токенов, лучше AI-приложения
- **Сложную часть берём на себя**: rotating proxies, orchestration, rate limits, JS-blocked content — zero configuration
- **Agent ready**: подключение к любому AI-агенту или MCP-клиенту одной командой
- **Media parsing**: PDF, DOCX и другие web-hosted документы
- **Actions**: click, scroll, write, wait, press — до извлечения контента
- **Open source**: прозрачная разработка — [сообщество](https://discord.gg/firecrawl)

---

## Обзор возможностей

**Core Endpoints**

| Возможность | Описание |
|---------|-------------|
| [**Search**](#search) | Поиск в вебе + полный контент страниц из результатов |
| [**Scrape**](#scrape) | Любой URL → markdown, HTML, screenshots или structured JSON |
| [**Interact**](#interact) | Scrape страницы, затем взаимодействие через AI-промпты или код |

**Ещё**

| Возможность | Описание |
|---------|-------------|
| [**Agent**](#agent) | Автосбор данных — просто опишите, что нужно |
| [**Crawl**](#crawl) | Все URL сайта одним запросом |
| [**Map**](#map) | Мгновенное обнаружение всех URL сайта |
| [**Batch Scrape**](#batch-scrape) | Асинхронный scrape тысяч URL |

---

## Быстрый старт

Зарегистрируйтесь на [firecrawl.dev](https://firecrawl.dev), получите API key. Попробуйте [playground](https://firecrawl.dev/playground).

### Search

Поиск в вебе с полным контентом результатов.

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

Вывод:
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

LLM-ready данные с любого сайта — markdown, JSON, screenshots и другое.

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

Вывод:
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

Scrape страницы, затем взаимодействие через AI-промпты или код.

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

Вывод:
```json
{
  "success": true,
  "output": "Keyboard available at $100",
  "liveViewUrl": "https://liveview.firecrawl.dev/..."
}
```

---

## Усильте своего агента

Подключите Firecrawl к любому AI-агенту или MCP-клиенту за минуты.

### Skill

Доступ агента к real-time web data одной командой.

```bash
npx -y firecrawl-cli@latest init --all --browser
```

После установки перезапустите агента. Работает с [Claude Code](https://claude.ai/code), [Antigravity](https://antigravity.google), [OpenCode](https://opencode.ai) и другими.

### MCP

Любой MCP-совместимый клиент — к вебу за секунды.

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

Вы AI-агент? Загрузите этот skill: signup пользователя, API key и старт с Firecrawl.

```bash
curl -s https://firecrawl.dev/agent-onboarding/SKILL.md
```

Документация Skill + CLI: [docs](https://docs.firecrawl.dev/sdks/cli). MCP: [firecrawl-mcp-server](https://github.com/firecrawl/firecrawl-mcp-server).

---

## Другие endpoints

### Agent

**Самый простой способ получить данные из веба.** Опишите задачу — AI-агент ищет, навигирует и возвращает результат. URL знать не обязательно.

Agent — эволюция endpoint `/extract`: быстрее, надёжнее, без обязательных URL заранее.
```bash
curl -X POST 'https://api.firecrawl.dev/v2/agent' \
  -H 'Authorization: Bearer fc-YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "Find the pricing plans for Notion"
  }'
```

Ответ:
```json
{
  "success": true,
  "data": {
    "result": "Notion offers the following pricing plans:\n\n1. Free - $0/month...\n2. Plus - $10/seat/month...\n3. Business - $18/seat/month...",
    "sources": ["https://www.notion.so/pricing"]
  }
}
```

#### Agent со structured output

Схема для структурированных данных:
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

#### Agent с URL (опционально)

Сфокусировать агента на конкретных страницах:
```python
result = app.agent(
    urls=["https://docs.firecrawl.dev", "https://firecrawl.dev/pricing"],
    prompt="Compare the features and pricing information"
)
```

#### Выбор модели

| Model | Cost | Best For |
|-------|------|----------|
| `spark-1-mini` (default) | на 60% дешевле | Большинство задач |
| `spark-1-pro` | standard | Сложный research, критичный сбор данных |
```python
result = app.agent(
    prompt="Compare enterprise features across Firecrawl, Apify, and ScrapingBee",
    model="spark-1-pro"
)
```

**Когда брать Pro:**
- сравнение данных по нескольким сайтам;
- сайты со сложной навигацией / auth;
- research с несколькими путями;
- задачи, где критична точность.

Подробнее: [Agent documentation](https://docs.firecrawl.dev/features/agent).

### Crawl

Crawl всего сайта и контент со всех страниц.
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

Возвращает job ID:
```json
{
  "success": true,
  "id": "123-456-789",
  "url": "https://api.firecrawl.dev/v2/crawl/123-456-789"
}
```

#### Статус crawl
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

**Примечание:** [SDK](#sdks) сами делают polling — удобнее для разработчика.

### Map

Мгновенно обнаружить все URL сайта.
```bash
curl -X POST 'https://api.firecrawl.dev/v2/map' \
  -H 'Authorization: Bearer fc-YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://firecrawl.dev"}'
```

Ответ:
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

#### Map с search

Найти конкретные URL внутри сайта:
```python
from firecrawl import Firecrawl

app = Firecrawl(api_key="fc-YOUR_API_KEY")

result = app.map("https://firecrawl.dev", search="pricing")
# Returns URLs ordered by relevance to "pricing"
```

### Batch Scrape

Scrape нескольких URL сразу:
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

## SDK

SDK упрощают все возможности Firecrawl и автоматически обрабатывают polling для async-операций.

### Python

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

Зависимость ([Gradle/Maven](https://docs.firecrawl.dev/sdks/java#installation)):
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

## Интеграции

**Agents & AI Tools**
- [Firecrawl Skill](https://docs.firecrawl.dev/sdks/cli)
- [Firecrawl CLI Skills](https://github.com/firecrawl/cli#agent-skills)
- [Firecrawl Workflows](https://github.com/firecrawl/firecrawl-workflows)
- [Firecrawl MCP](https://github.com/mendableai/firecrawl-mcp-server)

**Platforms**
- [Lovable](https://docs.lovable.dev/integrations/firecrawl)
- [Zapier](https://zapier.com/apps/firecrawl/integrations)
- [n8n](https://n8n.io/integrations/firecrawl/)

[Все интеграции →](https://www.firecrawl.dev/integrations)

**Нет вашего инструмента?** [Откройте issue](https://github.com/mendableai/firecrawl/issues)!

---

## Ресурсы

- [Документация](https://docs.firecrawl.dev)
- [API Reference](https://docs.firecrawl.dev/api-reference/introduction)
- [Playground](https://firecrawl.dev/playground)
- [Changelog](https://firecrawl.dev/changelog)

---

## Open Source vs Cloud

Firecrawl — open source под лицензией AGPL-3.0. Cloud-версия на [firecrawl.dev](https://firecrawl.dev) включает дополнительные возможности:

![Open Source vs Cloud](https://raw.githubusercontent.com/firecrawl/firecrawl/main/img/open-source-cloud.png)

Локальный запуск: [Contributing Guide](https://github.com/firecrawl/firecrawl/blob/main/CONTRIBUTING.md). Self-host: [Self-Hosting Guide](https://docs.firecrawl.dev/contributing/self-host).

---

## Участие (Contributing)

Мы любим contributions! Перед PR прочитайте [Contributing Guide](https://github.com/firecrawl/firecrawl/blob/main/CONTRIBUTING.md).

### Contributors

<a href="https://github.com/firecrawl/firecrawl/graphs/contributors">
  <img alt="contributors" src="https://contrib.rocks/image?repo=firecrawl/firecrawl"/>
</a>

---

## Лицензия

Проект в основном под GNU Affero General Public License v3.0 (AGPL-3.0). SDK и часть UI-компонентов — MIT. См. LICENSE в конкретных директориях.

---

**Пользователь сам отвечает за соблюдение политик сайтов при scraping.** Соблюдайте privacy policy и terms of use. По умолчанию Firecrawl уважает robots.txt. Используя Firecrawl, вы соглашаетесь с этими условиями.

<p align="right" style="font-size: 14px; color: #555; margin-top: 20px;">
  <a href="#readme-top" style="text-decoration: none; color: #007bff; font-weight: bold;">
    ↑ Наверх ↑
  </a>
</p>
