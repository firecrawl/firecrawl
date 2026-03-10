---
title: "Introducing /search: Discover and scrape the web with one API call"
description: "Search the web and get LLM-ready page content for each result in one simple API call. Perfect for agents, devs, and anyone who needs web data fast."
pubDate: "Jun 03, 2025"
heroImage: "../../assets/blog/search-endpoint.jpg"
category: "updates"
---

We’re shipping **/search** today – the endpoint that allows you to search and scrape all with one API call. Whether you’re building agents, doing research, finding leads, or working on SEO optimization, you need to find and get the right web data. Now you can get it with one API call.

## Reinventing Page Discovery

Everyone’s been asking for this – an endpoint that combines search with scraping. Makes sense when you think about it. Agents and developers constantly need to discover pages, then extract their content.

## How It Works

Using /search in code is straightforward. Here’s a quick example:

```python
from firecrawl import FirecrawlApp, ScrapeOptions

app = FirecrawlApp(api_key="fc-YOUR_API_KEY")

# Search and scrape in one call
results = app.search(
    "latest AI agent frameworks",
    limit=5,
    scrape_options=ScrapeOptions(formats=["markdown", "links"])
)

# Get search results with full content
for result in results.data:
    print(f"Title: {result['title']}")
    print(f"Content: {result['markdown'][:200]}...")
```

Everything’s customizable – language, location, time range, output formats, and beyond. Want results from last week in German? Simply add tbs="qdr:w" and lang="de".

## Now Live Everywhere

On day one, we’ve added /search to all our integrations - Zapier, n8n, MCP, and more:

- API - Direct integration in your applications
- MCP - Perfect for Claude, Gemini, and OpenAI Agents
- Zapier - Add search to any workflow
- n8n - Create advanced search automations
- Playground - Try searches immediately

## Start Building Today

Ready to discover and extract web data with one API call?

- Read the [/search documentation](https://docs.firecrawl.dev/features/search)
- Experiment in the [Playground](https://firecrawl.link/search-pg)
- See /search [examples and templates](https://www.firecrawl.dev/templates)
- Share your projects on [Discord](https://discord.gg/firecrawl)

That’s /search — the simplest way to discover and scrape web pages. Excited to see what you build with it!

---

P.S. We’re no longer actively supporting our alpha endpoints /llmstxt and /deep-research starting June 30, 2025. Both will remain active but we just will not be pushing further updates. For an /llmstxt alternative, see this [Firecrawl example](https://github.com/firecrawl/create-llmstxt-py). For deep research, check out our new Search API or our open source [Firesearch](https://github.com/firecrawl/firesearch) project.
