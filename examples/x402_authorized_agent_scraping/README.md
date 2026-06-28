# Authorized Agent Scraping

An example showing how to verify an AI agent's identity and permissions before it makes paid API calls through Firecrawl.

## The Problem

With x402 and similar pay-per-call protocols, any agent with a crypto wallet can call paid APIs. But there's no standard way to answer:

- **Which agent** is making this call?
- **Does it have permission** to spend money on API calls?
- **Who authorized it**, and when does that authorization expire?

Without an identity layer, operators have no way to control which of their agents can make financial API calls — or to revoke that access later.

## What This Example Does

1. **Creates an operator identity** — the human or organization that owns the agent
2. **Issues an agent credential** — a signed, time-limited credential with specific permissions (in this case, `READ_DATA` + `FINANCIAL_SMALL` for paid APIs under $100)
3. **Generates a zero-knowledge proof** — the agent proves it holds a valid credential without revealing the operator's secret key
4. **Verifies the proof** — the authorization check passes or fails
5. **Scrapes via Firecrawl** — only if the agent is authorized

The authorization check is local (no network call to a central auth server). The ZK proof reveals nothing about the operator's secrets.

## Prerequisites

- Python 3.11+
- Node.js 18+ (required by the ZK proof engine)
- [Firecrawl](https://firecrawl.dev) API key
- [@bolyra/sdk](https://www.npmjs.com/package/@bolyra/sdk) installed globally or in a sibling directory

## Setup

1. Install Python dependencies:
   ```
   pip install -r requirements.txt
   ```

2. Install the Node.js SDK (needed for ZK proof generation):
   ```
   npm install @bolyra/sdk
   ```

3. Set your Firecrawl API key:
   ```
   export FIRECRAWL_API_KEY=your_firecrawl_api_key
   ```

## Usage

```
python authorized_scrape.py
```

You'll be prompted for a URL to scrape. The script will:
- Create operator + agent identities
- Run the authorization check (ZK handshake)
- Scrape the URL only if authorization succeeds

## How It Works

```
Operator (human)                    Agent (AI)
      |                                |
      |-- issues credential ---------->|  (signed, scoped, time-limited)
      |                                |
      |                                |-- prove_handshake() -->  ZK Proof
      |                                |
      |                     Verifier <--|-- verify_handshake()
      |                                |
      |                                |-- [authorized] --> Firecrawl x402 API
```

The credential uses a permission bitmask. For this example, the agent gets:
- `READ_DATA` (bit 0) — can receive scrape results
- `FINANCIAL_SMALL` (bit 2) — can make paid API calls under $100

Permissions are cumulative: `FINANCIAL_MEDIUM` implies `FINANCIAL_SMALL`, and `FINANCIAL_UNLIMITED` implies both. This prevents accidental privilege escalation.

## Extending This

- **Multi-agent fleets**: Issue different credentials to different agents. A research agent gets `READ_DATA` only; a purchasing agent gets `FINANCIAL_SMALL`.
- **Delegation**: An authorized agent can delegate a *narrower* set of permissions to a sub-agent (delegation can only reduce scope, never expand it).
- **Expiry**: Set short-lived credentials (e.g., 1 hour) for sensitive operations.
- **Audit trail**: Log the `session_nonce` from each handshake to trace which authorization was used for which API call.

## License

[MIT](../../LICENSE)
