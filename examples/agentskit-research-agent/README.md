# Firecrawl research agent with AgentsKit

Use Firecrawl as a managed web-reading tool inside a provider-independent
AgentsKit runtime. The agent scrapes a page before answering, so its summary is
grounded in the page content instead of relying on model memory.

## What this demonstrates

- Firecrawl's `scrape` API exposed as a typed agent tool
- a complete tool-calling loop managed by AgentsKit
- a model adapter that can be replaced without changing the Firecrawl tool

## Run it

Requires Node.js 20 or newer.

```bash
cd examples/agentskit-research-agent
npm install
cp .env.example .env
```

Add a [Firecrawl API key](https://www.firecrawl.dev/app/api-keys) and a
[Google AI Studio key](https://aistudio.google.com/app/apikey) to `.env`, then
run:

```bash
npm start
```

By default, the agent summarizes the Firecrawl blog. Set `TARGET_URL` in `.env`
to research a different public page.

## How it works

`firecrawl()` provides `firecrawl_scrape` and `firecrawl_crawl` as AgentsKit
tools against Firecrawl's current v2 API. The system prompt requires the agent
to call `firecrawl_scrape` before it answers. The runtime handles the model/tool
loop and returns the final grounded response.

The example uses Gemini, but the runtime is not coupled to it. You can replace
`gemini()` with another
[AgentsKit adapter](https://www.agentskit.io/docs/data/providers) without
changing the Firecrawl configuration or research flow.

## Verify

```bash
npm run typecheck
```
