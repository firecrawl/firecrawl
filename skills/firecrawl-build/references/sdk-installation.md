# SDK Installation

Install the SDK that matches the project language. Prefer the language already used by the app.

For existing projects, inspect the repo first and match its package manager, dependency conventions, and where third-party API clients already live.

## JavaScript / TypeScript

```bash
npm install @mendable/firecrawl-js
```

## Python

```bash
pip install firecrawl-py
```

## REST

Use direct HTTP calls when:

- the project language does not have an official SDK in scope
- the existing networking layer already wraps third-party APIs
- the integration needs a minimal dependency footprint

After installation, run a smoke test from the real integration path. See [verification.md](verification.md).

Source of truth for SDK usage, schemas, and endpoint details (read the page matching your language):

- **Node / TypeScript**: [docs.firecrawl.dev/agent-source-of-truth/node](https://docs.firecrawl.dev/agent-source-of-truth/node)
- **Python**: [docs.firecrawl.dev/agent-source-of-truth/python](https://docs.firecrawl.dev/agent-source-of-truth/python)
- **Rust**: [docs.firecrawl.dev/agent-source-of-truth/rust](https://docs.firecrawl.dev/agent-source-of-truth/rust)
- **Java**: [docs.firecrawl.dev/agent-source-of-truth/java](https://docs.firecrawl.dev/agent-source-of-truth/java)
- **Elixir**: [docs.firecrawl.dev/agent-source-of-truth/elixir](https://docs.firecrawl.dev/agent-source-of-truth/elixir)
- **cURL / REST**: [docs.firecrawl.dev/agent-source-of-truth/curl](https://docs.firecrawl.dev/agent-source-of-truth/curl)
