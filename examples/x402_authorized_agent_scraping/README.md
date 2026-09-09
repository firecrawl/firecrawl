# Per-Agent Access Control for Firecrawl

Gate Firecrawl API calls behind agent identity verification so only credentialed agents can scrape.

## Why This Matters

When multiple AI agents share a Firecrawl API key, you have no way to answer:

- **Which agent** made this scrape request?
- **Is it allowed** to call paid endpoints?
- **When does its access expire?**

This example adds a lightweight authorization layer in front of Firecrawl. Before an agent can scrape, it must prove it holds a valid, time-limited credential with the right permissions. The check runs locally (no extra network call).

## Prerequisites

- **Python 3.11+**
- **Node.js 18+** — the ZK proof engine runs in Node. The Python SDK (`bolyra`) wraps `@bolyra/sdk` via a subprocess call, so both runtimes are needed.
- A [Firecrawl](https://firecrawl.dev) API key

## Quick Start

```bash
# Python deps
pip install -r requirements.txt

# Node.js dep (ZK proof engine)
npm install @bolyra/sdk

# Configure
cp .env.example .env   # then add your FIRECRAWL_API_KEY

# Run
python authorized_scrape.py
```

## How It Works

```
Operator                        Agent
   |                              |
   |-- issue credential -------->|   (scoped permissions, TTL)
   |                              |
   |                              |-- authorize()  -->  ZK proof
   |                              |                     (local, no network)
   |                              |
   |                              |-- [authorized] -->  Firecrawl scrape
```

1. **`agent_auth.py`** — helper that wraps [Bolyra](https://github.com/bolyra/bolyra) identity primitives into two calls: `create_agent_identity()` and `authorize()`.
2. **`authorized_scrape.py`** — the Firecrawl example. Creates an identity, runs the auth check, then scrapes.

Permissions are bitmask-based. This example grants `READ_DATA` + `FINANCIAL_SMALL` (paid calls under $100). Swap or narrow the permission set in `agent_auth.py` to match your use case.

## Extending This

- Issue different credentials per agent to enforce least-privilege across a fleet.
- Set short TTLs for sensitive scraping jobs.

## License

[MIT](../../LICENSE)
