# 🕷️ SynapticChain HTTP 402 Micropayment Integration for Firecrawl

This recipe demonstrates how to protect self-hosted Firecrawl API nodes with **native Layer-1 HTTP 402 micropayments ($0.0008 / scrape)**, enabling autonomous AI agents to pay for web scraping in sub-300ms without API keys or credit card subscriptions.

## 📦 Package
```bash
npm install @synaptics-lab/firecrawl-x402
```

## ⚡ Quickstart

Configure the HTTP 402 micropayment middleware in front of your self-hosted Firecrawl instance (running on port `3002`) and run the gateway on port `3003`.

```typescript
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { firecrawlX402Middleware } from '@synaptics-lab/firecrawl-x402';

const app = express();
app.use(express.json());

// Protect with $0.0008 Layer-1 Micropayments
app.use('/v1/scrape', firecrawlX402Middleware({
  feeRecipient: process.env.FEE_RECIPIENT || 'syn1dejphz2hjetjqva9fg39c7hg8gpr7muapqyvq7',
  costPerScrape: '0.0008',
  currency: 'sUSD'
}));

// Proxy paid requests forward to self-hosted Firecrawl backend (running on port 3002)
app.use('/v1/scrape', createProxyMiddleware({
  target: 'http://localhost:3002',
  changeOrigin: true
}));

app.listen(3003, () => console.log('Firecrawl x402 gateway running on port 3003'));
```

> **Note on Replay Protection & Verification:**
> The `firecrawlX402Middleware` ensures full replay protection and payment security:
> - **Receipt Status & Finality**: Confirms the transaction receipt status on-chain before authorizing the request.
> - **Recipient Matching**: Verifies that the recipient in the transaction matches the configured `feeRecipient`.
> - **Amount & Currency Matching**: Verifies that the transferred amount and token symbol strictly match the required `costPerScrape` and `currency`.
> - **One-time Nonce / Tx Hash Tracking**: Replay attacks are prevented by validating and storing spent transaction hashes.

## 🌐 References
- Official Repository: https://github.com/Synaptics-Lab/firecrawl-x402
- Explorer: https://explorer.synapticchain.xyz
